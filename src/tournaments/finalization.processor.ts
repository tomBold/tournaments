import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { FINALIZATION_QUEUE, FinalizationJob, FinalizationJobData } from './finalization.queue';
import { FinalizationService } from './finalization.service';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

@Processor(FINALIZATION_QUEUE)
export class FinalizationProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(FinalizationProcessor.name);

  constructor(
    private readonly finalization: FinalizationService,
    @InjectQueue(FINALIZATION_QUEUE) private readonly queue: Queue<FinalizationJobData>,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      FinalizationJob.Sweep,
      { every: this.config.sweepEveryMs },
      { name: FinalizationJob.Sweep, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  async process(job: Job<FinalizationJobData>): Promise<unknown> {
    switch (job.name) {
      case FinalizationJob.Finalize: {
        const outcome = await this.finalization.finalize(job.data.tournamentId);
        // Job fired early (e.g. clock skew between hosts): fail so BullMQ retries with backoff.
        if (outcome === 'not-ended') throw new Error('Tournament has not ended yet');
        return outcome;
      }
      case FinalizationJob.Sweep: {
        const overdue = await this.finalization.findOverdue();
        for (const id of overdue) await this.finalization.finalize(id);
        if (overdue.length) this.logger.warn(`Sweep finalized ${overdue.length} overdue tournament(s)`);
        return overdue.length;
      }
      default:
        throw new Error(`Unknown job ${job.name}`);
    }
  }
}
