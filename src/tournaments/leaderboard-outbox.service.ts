import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardBet, LeaderboardService } from './leaderboard.service';

const RELAY_BATCH_SIZE = 1_000;
const RELAY_TX_TIMEOUT_MS = 30_000;

interface OutboxRow {
  tournament_id: string;
  bet_id: string;
  player_id: string;
  amount: number;
  ends_at: Date;
  status: string;
}

/**
 * Applies counted bets from leaderboard_outbox to Redis and deletes them. The API already applied most of
 * them right after its commit; replaying those is a no-op thanks to the per-bet idempotent Lua script.
 */
@Injectable()
export class LeaderboardOutboxService {
  private readonly logger = new Logger(LeaderboardOutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /** Drains the outbox in batches. Returns how many bets the API had not applied to Redis itself. */
  async relay(): Promise<number> {
    let caughtUp = 0;
    for (;;) {
      const { rows, applied } = await this.relayBatch();
      caughtUp += applied;
      if (rows < RELAY_BATCH_SIZE) break;
    }
    if (caughtUp) this.logger.warn(`Outbox relay applied ${caughtUp} bet(s) missing from Redis`);
    return caughtUp;
  }

  private relayBatch(): Promise<{ rows: number; applied: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        // SKIP LOCKED lets several workers drain the outbox side by side without handling a row twice.
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT o.tournament_id, o.bet_id, tb.player_id, tb.amount, t.ends_at, t.status::text AS status
          FROM leaderboard_outbox o
          JOIN tournament_bets tb ON tb.tournament_id = o.tournament_id AND tb.bet_id = o.bet_id
          JOIN tournaments t ON t.id = o.tournament_id
          ORDER BY o.created_at
          LIMIT ${RELAY_BATCH_SIZE}
          FOR UPDATE OF o SKIP LOCKED`;
        if (rows.length === 0) return { rows: 0, applied: 0 };

        const byTournament = new Map<string, { endsAt: Date; bets: LeaderboardBet[] }>();
        for (const r of rows) {
          // A finalized leaderboard is served from Postgres and its keys were deleted; don't recreate them.
          if (r.status === 'FINALIZED') continue;
          const entry = byTournament.get(r.tournament_id) ?? { endsAt: r.ends_at, bets: [] };
          entry.bets.push({ betId: r.bet_id, playerId: r.player_id, amount: r.amount });
          byTournament.set(r.tournament_id, entry);
        }

        let applied = 0;
        for (const [tournamentId, { endsAt, bets }] of byTournament) {
          applied += await this.leaderboard.addBets(tournamentId, endsAt, bets);
        }

        // Only after Redis accepted every write: if one fails, the transaction rolls back and the rows
        // are picked up by the next run.
        await tx.$executeRaw`
          DELETE FROM leaderboard_outbox o
          USING unnest(${rows.map((r) => r.tournament_id)}::uuid[], ${rows.map((r) => r.bet_id)}::uuid[])
            AS done(tournament_id, bet_id)
          WHERE o.tournament_id = done.tournament_id AND o.bet_id = done.bet_id`;
        return { rows: rows.length, applied };
      },
      { timeout: RELAY_TX_TIMEOUT_MS },
    );
  }
}
