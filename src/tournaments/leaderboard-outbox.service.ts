import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardRepairService } from './leaderboard-repair.service';
import { LeaderboardBet, LeaderboardOutOfSyncError, LeaderboardService } from './leaderboard.service';

const RELAY_BATCH_SIZE = 1_000;
/** Per run, so a relay job always ends; whatever is left over goes to the next scheduled run. */
export const RELAY_MAX_BATCHES = 20;
const RELAY_TX_TIMEOUT_MS = 30_000;

interface OutboxRow {
  tournament_id: string;
  bet_id: string;
  player_id: string;
  amount: number;
  ends_at: Date;
  status: string;
}

interface BatchResult {
  rows: number;
  applied: number;
  outOfSync: Map<string, Date>;
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
    private readonly repair: LeaderboardRepairService,
  ) {}

  /**
   * Drains up to RELAY_MAX_BATCHES batches of the outbox. Returns how many bets the API had not applied to
   * Redis itself.
   */
  async relay(): Promise<number> {
    let caughtUp = 0;
    const outOfSync = new Map<string, Date>();
    for (let batch = 0; batch < RELAY_MAX_BATCHES; batch++) {
      const result = await this.relayBatch();
      caughtUp += result.applied;
      for (const [id, endsAt] of result.outOfSync) outOfSync.set(id, endsAt);
      if (result.rows < RELAY_BATCH_SIZE) break;
    }
    if (caughtUp) this.logger.warn(`Outbox relay applied ${caughtUp} bet(s) missing from Redis`);

    // Outside the batch transactions: a rebuild reads every bet of the tournament and can take a while. If it
    // fails, the keys stay partially lost, so the repair job still sees the tournament as out of sync.
    for (const [tournamentId, endsAt] of outOfSync) {
      this.logger.warn(`Rebuilding the partially lost live leaderboard of tournament ${tournamentId}`);
      await this.repair.rebuild(tournamentId, endsAt);
    }
    return caughtUp;
  }

  private relayBatch(): Promise<BatchResult> {
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
        const outOfSync = new Map<string, Date>();
        if (rows.length === 0) return { rows: 0, applied: 0, outOfSync };

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
          try {
            applied += await this.leaderboard.addBets(tournamentId, endsAt, bets);
          } catch (err) {
            if (!(err instanceof LeaderboardOutOfSyncError)) throw err;
            // These bets are in tournament_bets, so the rebuild after this transaction includes them.
            outOfSync.set(tournamentId, endsAt);
          }
        }

        // Only after Redis accepted every write: if one fails, the transaction rolls back and the rows
        // are picked up by the next run.
        await tx.$executeRaw`
          DELETE FROM leaderboard_outbox o
          USING unnest(${rows.map((r) => r.tournament_id)}::uuid[], ${rows.map((r) => r.bet_id)}::uuid[])
            AS done(tournament_id, bet_id)
          WHERE o.tournament_id = done.tournament_id AND o.bet_id = done.bet_id`;
        return { rows: rows.length, applied, outOfSync };
      },
      { timeout: RELAY_TX_TIMEOUT_MS },
    );
  }
}
