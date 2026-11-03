import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../clock/clock.service';
import { PrismaService } from '../prisma/prisma.service';
import { LockSpace } from './advisory-locks';
import { LeaderboardService } from './leaderboard.service';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

export type FinalizeOutcome = 'finalized' | 'already-finalized' | 'not-found' | 'not-ended';

@Injectable()
export class FinalizationService {
  private readonly logger = new Logger(FinalizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Writes final placements and marks the tournament FINALIZED. Idempotent and safe to retry.
   *
   * Two steps, so bets never wait for the aggregate: closing (OPEN → CLOSING) only holds the tournament lock
   * long enough to flip the status, after which no bet can be counted. The placements are then computed with
   * no lock held. A crash in between leaves the tournament CLOSING, and a retry or the sweep resumes it.
   *
   * Placements are computed from tournament_bets (the durable record of counted bets) rather than
   * read back from Redis; both hold the same sums, but Postgres survives Redis data loss.
   */
  async finalize(tournamentId: string): Promise<FinalizeOutcome> {
    const now = this.clock.now();
    const closed = await this.close(tournamentId, now);
    const outcome = closed === 'closed' ? await this.writeResults(tournamentId, now) : closed;

    this.logger.log(`Tournament ${tournamentId}: ${outcome}`);

    // The leaderboard is now served from tournament_results, so the live keys (including one entry per
    // counted bet) only cost memory. Retried on 'already-finalized' in case an earlier attempt failed here.
    if (outcome === 'finalized' || outcome === 'already-finalized') {
      try {
        await this.leaderboard.clear(tournamentId);
      } catch (err) {
        // Not fatal: the keys still expire after LEADERBOARD_TTL_AFTER_END_SECONDS.
        this.logger.warn(`Could not clear live leaderboard of ${tournamentId}: ${(err as Error).message}`);
      }
    }
    return outcome;
  }

  /** Tournaments past endsAt + grace that aren't finalized yet (e.g. their delayed job was lost). */
  async findOverdue(): Promise<string[]> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.finalizeGraceMs);
    const rows = await this.prisma.tournament.findMany({
      where: { status: { in: ['OPEN', 'CLOSING'] }, endsAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { endsAt: 'asc' },
      take: this.config.sweepBatchSize,
    });
    return rows.map((r) => r.id);
  }

  private close(
    tournamentId: string,
    now: Date,
  ): Promise<'closed' | Exclude<FinalizeOutcome, 'finalized'>> {
    return this.prisma.$transaction(async (tx) => {
      // Exclusive: waits for bets in flight (which hold it shared) and holds new ones back until the
      // status change is committed; they then re-read the status and skip this tournament.
      await tx.$executeRaw`
        SELECT 1 FROM pg_advisory_xact_lock(${LockSpace.Tournament}::int, hashtext(${tournamentId}))`;
      const [tournament] = await tx.$queryRaw<{ status: string; ends_at: Date }[]>`
        SELECT status::text AS status, ends_at FROM tournaments WHERE id = ${tournamentId}::uuid`;

      if (!tournament) return 'not-found';
      if (tournament.status === 'FINALIZED') return 'already-finalized';
      if (tournament.ends_at.getTime() > now.getTime()) return 'not-ended';
      if (tournament.status === 'OPEN') {
        await tx.tournament.update({ where: { id: tournamentId }, data: { status: 'CLOSING' } });
      }
      return 'closed';
    });
  }

  private async writeResults(tournamentId: string, now: Date): Promise<'finalized'> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO tournament_results (tournament_id, player_id, score, placement)
          SELECT tournament_id,
                 player_id,
                 SUM(amount)::bigint,
                 (RANK() OVER (ORDER BY SUM(amount) DESC))::int
          FROM tournament_bets
          WHERE tournament_id = ${tournamentId}::uuid
          GROUP BY tournament_id, player_id
          ON CONFLICT (tournament_id, player_id) DO NOTHING`;

        // Conditional, so a concurrent run that already finished doesn't get its finalizedAt overwritten.
        await tx.tournament.updateMany({
          where: { id: tournamentId, status: 'CLOSING' },
          data: { status: 'FINALIZED', finalizedAt: now },
        });
      },
      { timeout: this.config.finalizeTimeoutMs },
    );
    return 'finalized';
  }
}
