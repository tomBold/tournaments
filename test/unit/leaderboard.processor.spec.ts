import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { LeaderboardOutboxService } from '../../src/tournaments/leaderboard-outbox.service';
import { LeaderboardRepairService } from '../../src/tournaments/leaderboard-repair.service';
import { LeaderboardProcessor } from '../../src/tournaments/leaderboard.processor';
import { LEADERBOARD_QUEUE, LeaderboardJob } from '../../src/tournaments/leaderboard.queue';
import { tournamentsConfig } from '../../src/tournaments/tournaments.config';
import { testConfig } from '../support/test-config';

const job = (name: string) => ({ name, data: {} }) as Job;

describe('LeaderboardProcessor', () => {
  const outbox = { relay: jest.fn() };
  const repair = { repairOutOfSync: jest.fn() };
  const queue = { upsertJobScheduler: jest.fn() };
  let processor: LeaderboardProcessor;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    jest.resetAllMocks();
    moduleRef = await Test.createTestingModule({
      providers: [
        LeaderboardProcessor,
        { provide: LeaderboardOutboxService, useValue: outbox },
        { provide: LeaderboardRepairService, useValue: repair },
        { provide: getQueueToken(LEADERBOARD_QUEUE), useValue: queue },
        { provide: tournamentsConfig.KEY, useValue: testConfig },
      ],
    }).compile();
    processor = moduleRef.get(LeaderboardProcessor);
  });

  afterEach(() => moduleRef.close());

  it('registers the outbox relay and repair schedulers with their configured intervals', async () => {
    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler.mock.calls.map(([name, repeat, template]) => [name, repeat, template.name])).toEqual([
      [LeaderboardJob.RelayOutbox, { every: testConfig.leaderboardOutboxEveryMs }, LeaderboardJob.RelayOutbox],
      [
        LeaderboardJob.RepairLeaderboards,
        { every: testConfig.leaderboardRepairEveryMs },
        LeaderboardJob.RepairLeaderboards,
      ],
    ]);
  });

  it('drains the outbox for a relay job', async () => {
    outbox.relay.mockResolvedValue(3);

    await expect(processor.process(job(LeaderboardJob.RelayOutbox))).resolves.toBe(3);
  });

  it('runs the leaderboard repair for a repair job', async () => {
    repair.repairOutOfSync.mockResolvedValue(1);

    await expect(processor.process(job(LeaderboardJob.RepairLeaderboards))).resolves.toBe(1);
  });

  it('rejects unknown job names', async () => {
    await expect(processor.process(job('nope'))).rejects.toThrow('Unknown job nope');
  });
});
