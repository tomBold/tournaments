import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Clock } from '../clock/clock.service';
import { PrismaService } from '../prisma/prisma.service';
import { LockSpace } from './advisory-locks';
import { CreateBetDto } from './dto/create-bet.dto';
import { LeaderboardService } from './leaderboard.service';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

/**
 * A bet only ever waits for other bets of the same player and for the short "close" step of finalization,
 * never for the placements aggregate, so it needs no more than a little over Prisma's 5 s default.
 */
const BET_TX_TIMEOUT_MS = 10_000;

/** Highest score a player can reach in one tournament: Redis scores and API numbers are exact up to here. */
export const MAX_SCORE = Number.MAX_SAFE_INTEGER;

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
  private readonly logger = new Logger(BetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
    private readonly clock: Clock,
  ) {}

  async ingest(dto: CreateBetDto): Promise<IngestBetResult> {
    const createdAt = new Date(dto.createdAt);

    const { bet, betIsNew, matched, newlyCounted } = await this.prisma.$transaction(
      async (tx) => {
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

        const candidates = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM tournaments
          WHERE status = 'OPEN'
            AND currency = ${dto.currency}
            AND starts_at <= ${createdAt}
            AND ends_at >= ${createdAt}
          ORDER BY id`;

        let matched: { id: string; ends_at: Date }[] = [];
        let newlyCounted: string[] = [];
        if (candidates.length > 0) {
          // Shared lock per tournament, held until commit. Finalization takes it exclusively to close the
          // tournament, so it waits for bets in flight and no bet is counted after closing. Unlike FOR SHARE,
          // an advisory lock never writes to the tournament row, so concurrent bets on a busy tournament
          // don't contend on it. Taken in id order, so two bets can't deadlock on each other's tournaments.
          for (const { id } of candidates) {
            await tx.$executeRaw`
              SELECT 1 FROM pg_advisory_xact_lock_shared(${LockSpace.Tournament}::int, hashtext(${id}))`;
          }
          // Re-read under the locks: a tournament closed in between no longer counts.
          matched = await tx.$queryRaw<{ id: string; ends_at: Date }[]>`
            SELECT id, ends_at FROM tournaments
            WHERE id = ANY(${candidates.map((t) => t.id)}::uuid[]) AND status = 'OPEN'
            ORDER BY id`;
        }

        if (matched.length > 0) {
          const tournamentIds = matched.map((t) => t.id);

          // Serializes this player's concurrent bets, so two of them cannot both pass the limit check.
          // Taken last: whoever holds it waits for nothing else, so the locks can't deadlock.
          await tx.$executeRaw`
            SELECT 1 FROM pg_advisory_xact_lock(${LockSpace.Player}::int, hashtext(${bet.player_id}))`;
          const overLimit = await tx.$queryRaw<{ tournament_id: string }[]>`
            SELECT tournament_id FROM tournament_bets
            WHERE tournament_id = ANY(${tournamentIds}::uuid[])
              AND player_id = ${bet.player_id}
              AND bet_id <> ${bet.id}::uuid
            GROUP BY tournament_id
            HAVING SUM(amount) + ${bet.amount} > ${BigInt(MAX_SCORE)}::bigint`;
          if (overLimit.length > 0) {
            throw new UnprocessableEntityException(
              `Bet would push player ${bet.player_id} past the maximum score of ${MAX_SCORE} in tournament(s) ` +
                overLimit.map((r) => r.tournament_id).join(', '),
            );
          }

          // The outbox row commits together with the count, so the worker's relay can bring Redis up to
          // date even if the write below never happens.
          const rows = await tx.$queryRaw<{ tournament_id: string }[]>`
            WITH counted AS (
              INSERT INTO tournament_bets (tournament_id, bet_id, player_id, amount)
              SELECT t.id, ${bet.id}::uuid, ${bet.player_id}, ${bet.amount}
              FROM unnest(${tournamentIds}::uuid[]) AS t(id)
              ON CONFLICT (tournament_id, bet_id) DO NOTHING
              RETURNING tournament_id, bet_id
            ), queued AS (
              INSERT INTO leaderboard_outbox (tournament_id, bet_id)
              SELECT tournament_id, bet_id FROM counted
            )
            SELECT tournament_id FROM counted`;
          newlyCounted = rows.map((r) => r.tournament_id);
        }

        return { bet, betIsNew: inserted.length > 0, matched, newlyCounted };
      },
      { timeout: BET_TX_TIMEOUT_MS },
    );

    // Applied for every matching tournament, not only the newly counted ones: the Redis script is
    // idempotent per bet, so a retry also repairs a write that was lost after the outbox row was relayed.
    // A failure is not the client's problem: the bet is committed and the outbox relay applies it.
    try {
      await Promise.all(
        matched.map((t) =>
          this.leaderboard.addBet(t.id, t.ends_at, bet.id, bet.player_id, bet.amount),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Live leaderboard update for bet ${dto.externalBetId} failed, left to the outbox relay: ` +
          (err as Error).message,
      );
    }

    // A tournament is finalized no earlier than endsAt + grace, so a bet created within the last grace
    // period can't have missed one; skipping the check keeps it off the path of live bets.
    if (createdAt.getTime() < this.clock.now().getTime() - this.config.finalizeGraceMs) {
      await this.warnIfLate(bet.id, dto, createdAt);
    }

    return {
      betId: bet.id,
      externalBetId: dto.externalBetId,
      duplicate: !betIsNew && newlyCounted.length === 0,
      countedTournamentIds: newlyCounted,
    };
  }

  /** Logs closed or finalized tournaments that this bet falls into but was never counted towards. */
  private async warnIfLate(betId: string, dto: CreateBetDto, createdAt: Date): Promise<void> {
    try {
      const missed = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM tournaments t
        WHERE t.status IN ('CLOSING', 'FINALIZED')
          AND t.currency = ${dto.currency}
          AND t.starts_at <= ${createdAt}
          AND t.ends_at >= ${createdAt}
          AND NOT EXISTS (
            SELECT 1 FROM tournament_bets tb WHERE tb.tournament_id = t.id AND tb.bet_id = ${betId}::uuid
          )`;
      if (missed.length > 0) {
        this.logger.warn(
          `Late bet ${dto.externalBetId} (createdAt ${dto.createdAt}) not counted towards already finalized ` +
            `tournament(s) ${missed.map((t) => t.id).join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.error(`Could not check bet ${dto.externalBetId} for late arrival`, err as Error);
    }
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
