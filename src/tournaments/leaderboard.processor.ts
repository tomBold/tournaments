import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { LeaderboardOutboxService } from './leaderboard-outbox.service';
import { LeaderboardRepairService } from './leaderboard-repair.service';
import { LEADERBOARD_QUEUE, LeaderboardJob } from './leaderboard.queue';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

@Processor(LEADERBOARD_QUEUE)
export class LeaderboardProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly outbox: LeaderboardOutboxService,
    private readonly repair: LeaderboardRepairService,
    @InjectQueue(LEADERBOARD_QUEUE) private readonly queue: Queue,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const schedules: [name: string, every: number][] = [
      [LeaderboardJob.RelayOutbox, this.config.leaderboardOutboxEveryMs],
      [LeaderboardJob.RepairLeaderboards, this.config.leaderboardRepairEveryMs],
    ];
    for (const [name, every] of schedules) {
      await this.queue.upsertJobScheduler(
        name,
        { every },
        { name, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    }
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case LeaderboardJob.RelayOutbox:
        return this.outbox.relay();
      case LeaderboardJob.RepairLeaderboards:
        return this.repair.repairOutOfSync();
      default:
        throw new Error(`Unknown job ${job.name}`);
    }
  }
}
