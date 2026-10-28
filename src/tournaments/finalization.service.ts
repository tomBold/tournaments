import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../clock/clock.service';
import { PrismaService } from '../prisma/prisma.service';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

export type FinalizeOutcome = 'finalized' | 'already-finalized' | 'not-found' | 'not-ended';

@Injectable()
export class FinalizationService {
  private readonly logger = new Logger(FinalizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Writes final placements and marks the tournament FINALIZED. Idempotent and safe to retry.
   *
   * Placements are computed from tournament_bets (the durable record of counted bets) rather than
   * read back from Redis; both hold the same sums, but Postgres survives Redis data loss.
   */
  async finalize(tournamentId: string): Promise<FinalizeOutcome> {
    const now = this.clock.now();
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        // FOR UPDATE waits for in-flight bet transactions (which hold FOR SHARE) and blocks new ones.
        const [tournament] = await tx.$queryRaw<{ status: string; ends_at: Date }[]>`
          SELECT status::text AS status, ends_at FROM tournaments
          WHERE id = ${tournamentId}::uuid
          FOR UPDATE`;

        if (!tournament) return 'not-found';
        if (tournament.status === 'FINALIZED') return 'already-finalized';
        if (tournament.ends_at.getTime() > now.getTime()) return 'not-ended';

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

        await tx.tournament.update({
          where: { id: tournamentId },
          data: { status: 'FINALIZED', finalizedAt: now },
        });
        return 'finalized';
      },
      { timeout: this.config.finalizeTimeoutMs },
    );

    this.logger.log(`Tournament ${tournamentId}: ${outcome}`);
    return outcome;
  }

  /** Tournaments past endsAt + grace that are still OPEN (e.g. their delayed job was lost). */
  async findOverdue(): Promise<string[]> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.finalizeGraceMs);
    const rows = await this.prisma.tournament.findMany({
      where: { status: 'OPEN', endsAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { endsAt: 'asc' },
      take: this.config.sweepBatchSize,
    });
    return rows.map((r) => r.id);
  }
}
