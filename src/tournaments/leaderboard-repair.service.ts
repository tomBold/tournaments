import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../clock/clock.service';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardBet, LeaderboardBetSource, LeaderboardService } from './leaderboard.service';

const REBUILD_BATCH_SIZE = 1_000;
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

/** Restores live leaderboards from tournament_bets after Redis lost or evicted them. */
@Injectable()
export class LeaderboardRepairService {
  private readonly logger = new Logger(LeaderboardRepairService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
    private readonly clock: Clock,
  ) {}

  /** Rebuilds every started, not yet finalized tournament whose Redis state is behind Postgres. Returns how many. */
  async repairOutOfSync(): Promise<number> {
    const tournaments = await this.prisma.$queryRaw<{ id: string; ends_at: Date; counted: number }[]>`
      SELECT t.id, t.ends_at, COUNT(tb.bet_id)::int AS counted
      FROM tournaments t
      LEFT JOIN tournament_bets tb ON tb.tournament_id = t.id
      WHERE t.status IN ('OPEN', 'CLOSING') AND t.starts_at <= ${this.clock.now()}
      GROUP BY t.id`;

    let rebuilt = 0;
    for (const t of tournaments) {
      // One failing tournament must not stop the others from being repaired.
      try {
        if (await this.leaderboard.isInSync(t.id, t.counted)) continue;
        await this.leaderboard.rebuild(t.id, t.ends_at, this.betsOf(t.id));
        rebuilt++;
      } catch (err) {
        this.logger.error(`Could not repair the live leaderboard of tournament ${t.id}`, err as Error);
      }
    }
    if (rebuilt) this.logger.warn(`Rebuilt ${rebuilt} live leaderboard(s) from Postgres`);
    return rebuilt;
  }

  private betsOf(tournamentId: string): LeaderboardBetSource {
    const prisma = this.prisma;
    return async function* () {
      let after = MIN_UUID;
      for (;;) {
        const rows = await prisma.$queryRaw<{ bet_id: string; player_id: string; amount: number }[]>`
          SELECT bet_id, player_id, amount FROM tournament_bets
          WHERE tournament_id = ${tournamentId}::uuid AND bet_id > ${after}::uuid
          ORDER BY bet_id
          LIMIT ${REBUILD_BATCH_SIZE}`;
        if (rows.length === 0) return;
        yield rows.map((r): LeaderboardBet => ({ betId: r.bet_id, playerId: r.player_id, amount: r.amount }));
        if (rows.length < REBUILD_BATCH_SIZE) return;
        after = rows[rows.length - 1].bet_id;
      }
    };
  }
}
