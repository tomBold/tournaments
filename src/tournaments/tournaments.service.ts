import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Tournament } from '@prisma/client';
import { Queue } from 'bullmq';
import { Clock } from '../clock/clock.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import {
  FINALIZATION_QUEUE,
  FinalizationJob,
  FinalizationJobData,
  finalizeJobId,
} from './finalization.queue';
import { decodeCursor, encodeCursor, LeaderboardCursor } from './leaderboard-cursor';
import { LeaderboardEntry, LeaderboardService } from './leaderboard.service';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

export interface LeaderboardPage {
  tournamentId: string;
  status: Tournament['status'];
  /** "live" = Redis ranking, "final" = placements persisted by the finalize job. */
  source: 'live' | 'final';
  total: number;
  limit: number;
  offset: number;
  items: LeaderboardEntry[];
  /** Pass as `cursor` to read the next page; null on the last page. */
  nextCursor: string | null;
}

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderboard: LeaderboardService,
    @InjectQueue(FINALIZATION_QUEUE) private readonly finalizationQueue: Queue<FinalizationJobData>,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
    private readonly clock: Clock,
  ) {}

  async create(dto: CreateTournamentDto): Promise<Tournament> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    const now = this.clock.now().getTime();
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    // An already-ended tournament would be finalized within seconds, freezing an empty leaderboard.
    if (endsAt.getTime() <= now) {
      throw new BadRequestException('endsAt must be in the future');
    }

    const tournament = await this.prisma.tournament.create({
      data: { name: dto.name, startsAt, endsAt, currency: dto.currency ?? 'USD' },
    });

    try {
      await this.finalizationQueue.add(
        FinalizationJob.Finalize,
        { tournamentId: tournament.id },
        {
          jobId: finalizeJobId(tournament.id),
          delay: Math.max(0, endsAt.getTime() - now + this.config.finalizeGraceMs),
          attempts: this.config.finalizeAttempts,
          backoff: { type: 'exponential', delay: this.config.finalizeBackoffMs },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (err) {
      // The tournament is already persisted; failing here would make clients retry and create duplicates.
      // The worker's periodic sweep finalizes tournaments whose job was never enqueued.
      this.logger.error(`Could not schedule finalize job for ${tournament.id}`, err as Error);
    }

    return tournament;
  }

  async getLeaderboard(
    tournamentId: string,
    limit: number,
    offset: number,
    cursor?: string,
  ): Promise<LeaderboardPage> {
    const position: LeaderboardCursor = cursor ? decodeCursor(cursor) : { offset };
    const tournament = await this.prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tournament) throw new NotFoundException(`Tournament ${tournamentId} not found`);

    const page = { tournamentId, status: tournament.status, limit, offset: position.offset };

    if (tournament.status === 'FINALIZED') {
      const { after } = position;
      // Ties ordered like Redis ZREVRANGE (byte-wise member DESC, hence COLLATE "C") so pages don't
      // reshuffle on finalization regardless of the database's locale.
      const start = after
        ? Prisma.sql`AND (placement > ${after.placement}
              OR (placement = ${after.placement} AND player_id COLLATE "C" < ${after.playerId} COLLATE "C"))`
        : Prisma.empty;
      const skip = after ? 0 : position.offset;
      const [total, results] = await Promise.all([
        this.prisma.tournamentResult.count({ where: { tournamentId } }),
        this.prisma.$queryRaw<{ placement: number; player_id: string; score: bigint }[]>`
          SELECT placement, player_id, score FROM tournament_results
          WHERE tournament_id = ${tournamentId}::uuid ${start}
          ORDER BY placement ASC, player_id COLLATE "C" DESC
          LIMIT ${limit} OFFSET ${skip}`,
      ]);
      const items = results.map((r) => ({
        placement: r.placement,
        playerId: r.player_id,
        score: Number(r.score),
      }));
      const last = items[items.length - 1];
      const nextOffset = position.offset + items.length;
      return {
        ...page,
        source: 'final',
        total,
        items,
        nextCursor:
          last && nextOffset < total
            ? encodeCursor({ offset: nextOffset, after: { placement: last.placement, playerId: last.playerId } })
            : null,
      };
    }

    const live = await this.leaderboard.getPage(tournamentId, limit, position.offset);
    const nextOffset = position.offset + live.items.length;
    return {
      ...page,
      source: 'live',
      ...live,
      nextCursor: live.items.length && nextOffset < live.total ? encodeCursor({ offset: nextOffset }) : null,
    };
  }
}
