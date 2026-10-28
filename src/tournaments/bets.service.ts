import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBetDto } from './dto/create-bet.dto';
import { LeaderboardService } from './leaderboard.service';

export interface IngestBetResult {
  betId: string;
  externalBetId: string;
  /** True when this exact bet had already been received and nothing new was counted. */
  duplicate: boolean;
  /** Tournaments this request newly counted the bet towards. */
  countedTournamentIds: string[];
}

interface BetRow {
  id: string;
  player_id: string;
  amount: number;
  currency: string;
  created_at: Date;
}

@Injectable()
export class BetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  async ingest(dto: CreateBetDto): Promise<IngestBetResult> {
    const createdAt = new Date(dto.createdAt);

    const { bet, betIsNew, matched, newlyCounted } = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<BetRow[]>`
        INSERT INTO bets (id, external_bet_id, player_id, amount, currency, created_at)
        VALUES (gen_random_uuid(), ${dto.externalBetId}, ${dto.playerId}, ${dto.amount}, ${dto.currency}, ${createdAt})
        ON CONFLICT (external_bet_id) DO NOTHING
        RETURNING id, player_id, amount, currency, created_at`;

      let bet = inserted[0];
      if (!bet) {
        [bet] = await tx.$queryRaw<BetRow[]>`
          SELECT id, player_id, amount, currency, created_at FROM bets
          WHERE external_bet_id = ${dto.externalBetId}`;
        assertSamePayload(bet, dto, createdAt);
      }

      // FOR SHARE blocks finalization (FOR UPDATE) until this bet is committed, so a bet can never
      // be counted into a tournament after its final placements have been written.
      const matched = await tx.$queryRaw<{ id: string; ends_at: Date }[]>`
        SELECT id, ends_at FROM tournaments
        WHERE status = 'OPEN'
          AND currency = ${dto.currency}
          AND starts_at <= ${createdAt}
          AND ends_at >= ${createdAt}
        ORDER BY id
        FOR SHARE`;

      let newlyCounted: string[] = [];
      if (matched.length > 0) {
        const rows = await tx.$queryRaw<{ tournament_id: string }[]>`
          INSERT INTO tournament_bets (tournament_id, bet_id, player_id, amount)
          SELECT t.id, ${bet.id}::uuid, ${bet.player_id}, ${bet.amount}
          FROM unnest(${matched.map((t) => t.id)}::uuid[]) AS t(id)
          ON CONFLICT (tournament_id, bet_id) DO NOTHING
          RETURNING tournament_id`;
        newlyCounted = rows.map((r) => r.tournament_id);
      }

      return { bet, betIsNew: inserted.length > 0, matched, newlyCounted };
    });

    // Applied for every matching tournament, not only the newly counted ones: the Redis script is
    // idempotent per bet, so a retry after a failed Redis write repairs the live leaderboard.
    await Promise.all(
      matched.map((t) =>
        this.leaderboard.addBet(t.id, t.ends_at, bet.id, bet.player_id, bet.amount),
      ),
    );

    return {
      betId: bet.id,
      externalBetId: dto.externalBetId,
      duplicate: !betIsNew && newlyCounted.length === 0,
      countedTournamentIds: newlyCounted,
    };
  }
}

function assertSamePayload(existing: BetRow, dto: CreateBetDto, createdAt: Date): void {
  const same =
    existing.player_id === dto.playerId &&
    existing.amount === dto.amount &&
    existing.currency === dto.currency &&
    existing.created_at.getTime() === createdAt.getTime();
  if (!same) {
    throw new ConflictException(
      `externalBetId ${dto.externalBetId} was already received with a different payload`,
    );
  }
}
