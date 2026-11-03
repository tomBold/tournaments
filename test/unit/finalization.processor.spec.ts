import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { FinalizationProcessor } from '../../src/tournaments/finalization.processor';
import {
  FINALIZATION_QUEUE,
  FinalizationJob,
  FinalizationJobData,
} from '../../src/tournaments/finalization.queue';
import { FinalizationService } from '../../src/tournaments/finalization.service';
import { LeaderboardOutboxService } from '../../src/tournaments/leaderboard-outbox.service';
import { LeaderboardRepairService } from '../../src/tournaments/leaderboard-repair.service';
import { tournamentsConfig } from '../../src/tournaments/tournaments.config';
import { testConfig } from '../support/test-config';

const job = (name: string, data: FinalizationJobData = { tournamentId: 't1' }) =>
  ({ name, data }) as Job<FinalizationJobData>;

describe('FinalizationProcessor', () => {
  const finalization = { finalize: jest.fn(), findOverdue: jest.fn() };
  const outbox = { relay: jest.fn() };
  const repair = { repairOutOfSync: jest.fn() };
  const queue = { upsertJobScheduler: jest.fn() };
  let processor: FinalizationProcessor;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const moduleRef = await Test.createTestingModule({
      providers: [
        FinalizationProcessor,
        { provide: FinalizationService, useValue: finalization },
        { provide: LeaderboardOutboxService, useValue: outbox },
        { provide: LeaderboardRepairService, useValue: repair },
        { provide: getQueueToken(FINALIZATION_QUEUE), useValue: queue },
        { provide: tournamentsConfig.KEY, useValue: testConfig },
      ],
    }).compile();
    processor = moduleRef.get(FinalizationProcessor);
  });

  afterEach(() => jest.restoreAllMocks());

  it('registers the sweep, outbox relay and repair schedulers with their configured intervals', async () => {
    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler.mock.calls.map(([name, repeat, template]) => [name, repeat, template.name])).toEqual([
      [FinalizationJob.Sweep, { every: testConfig.sweepEveryMs }, FinalizationJob.Sweep],
      [FinalizationJob.RelayOutbox, { every: testConfig.leaderboardOutboxEveryMs }, FinalizationJob.RelayOutbox],
      [
        FinalizationJob.RepairLeaderboards,
        { every: testConfig.leaderboardRepairEveryMs },
        FinalizationJob.RepairLeaderboards,
      ],
    ]);
  });

  it('drains the outbox for a relay job', async () => {
    outbox.relay.mockResolvedValue(3);

    await expect(processor.process(job(FinalizationJob.RelayOutbox))).resolves.toBe(3);
  });

  it('runs the leaderboard repair for a repair job', async () => {
    repair.repairOutOfSync.mockResolvedValue(1);

    await expect(processor.process(job(FinalizationJob.RepairLeaderboards))).resolves.toBe(1);
  });

  it('finalizes the tournament of a finalize job', async () => {
    finalization.finalize.mockResolvedValue('finalized');

    await expect(processor.process(job(FinalizationJob.Finalize))).resolves.toBe('finalized');
    expect(finalization.finalize).toHaveBeenCalledWith('t1');
  });

  it('treats an already finalized tournament as success (idempotent retry)', async () => {
    finalization.finalize.mockResolvedValue('already-finalized');

    await expect(processor.process(job(FinalizationJob.Finalize))).resolves.toBe('already-finalized');
  });

  it('fails a job that fired before endsAt so BullMQ retries it', async () => {
    finalization.finalize.mockResolvedValue('not-ended');

    await expect(processor.process(job(FinalizationJob.Finalize))).rejects.toThrow('not ended');
  });

  it('sweep finalizes every overdue tournament', async () => {
    finalization.findOverdue.mockResolvedValue(['t1', 't2']);
    finalization.finalize.mockResolvedValue('finalized');

    await expect(processor.process(job(FinalizationJob.Sweep))).resolves.toBe(2);
    expect(finalization.finalize.mock.calls).toEqual([['t1'], ['t2']]);
  });

  it('sweep continues with the remaining tournaments when one fails', async () => {
    finalization.findOverdue.mockResolvedValue(['t1', 't2', 't3']);
    finalization.finalize
      .mockResolvedValueOnce('finalized')
      .mockRejectedValueOnce(new Error('transaction timeout'))
      .mockResolvedValueOnce('finalized');

    await expect(processor.process(job(FinalizationJob.Sweep))).resolves.toBe(2);
    expect(finalization.finalize.mock.calls).toEqual([['t1'], ['t2'], ['t3']]);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('t2'),
      expect.any(Error),
    );
  });

  it('rejects unknown job names', async () => {
    await expect(processor.process(job('nope'))).rejects.toThrow('Unknown job nope');
  });
});
