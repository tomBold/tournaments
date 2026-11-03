import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LeaderboardRepairService } from '../../src/tournaments/leaderboard-repair.service';
import { LeaderboardBetSource, LeaderboardService } from '../../src/tournaments/leaderboard.service';
import { FakeClock } from '../support/fake-clock';

const ENDS_AT = new Date('2030-06-30T00:00:00.000Z');

describe('LeaderboardRepairService', () => {
  const prisma = { $queryRaw: jest.fn() };
  const leaderboard = { isInSync: jest.fn(), rebuild: jest.fn() };
  let service: LeaderboardRepairService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    service = new LeaderboardRepairService(
      prisma as unknown as PrismaService,
      leaderboard as unknown as LeaderboardService,
      new FakeClock(new Date('2030-06-15T00:00:00.000Z')),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('rebuilds only the tournaments whose Redis state is behind Postgres', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      { id: 't1', ends_at: ENDS_AT, counted: 3 },
      { id: 't2', ends_at: ENDS_AT, counted: 5 },
    ]);
    leaderboard.isInSync.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(service.repairOutOfSync()).resolves.toBe(1);

    expect(leaderboard.isInSync.mock.calls).toEqual([
      ['t1', 3],
      ['t2', 5],
    ]);
    expect(leaderboard.rebuild).toHaveBeenCalledTimes(1);
    expect(leaderboard.rebuild).toHaveBeenCalledWith('t2', ENDS_AT, expect.any(Function));
  });

  it('keeps repairing the other tournaments when one fails', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      { id: 't1', ends_at: ENDS_AT, counted: 1 },
      { id: 't2', ends_at: ENDS_AT, counted: 1 },
    ]);
    leaderboard.isInSync.mockResolvedValue(false);
    leaderboard.rebuild.mockRejectedValueOnce(new Error('Redis down')).mockResolvedValueOnce(undefined);

    await expect(service.repairOutOfSync()).resolves.toBe(1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('t1'), expect.any(Error));
  });

  it('rebuilds a single tournament on request from its counted bets', async () => {
    await service.rebuild('t1', ENDS_AT);

    expect(leaderboard.rebuild).toHaveBeenCalledWith('t1', ENDS_AT, expect.any(Function));
  });

  it('pages through tournament_bets in batches until a short batch', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 't1', ends_at: ENDS_AT, counted: 1001 }]);
    leaderboard.isInSync.mockResolvedValue(false);
    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({
      bet_id: `b${String(i).padStart(4, '0')}`,
      player_id: 'alice',
      amount: 1,
    }));
    prisma.$queryRaw
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([{ bet_id: 'b9999', player_id: 'bob', amount: 7 }]);

    let source: LeaderboardBetSource | undefined;
    leaderboard.rebuild.mockImplementation(async (_id, _endsAt, s: LeaderboardBetSource) => {
      source = s;
    });
    await service.repairOutOfSync();

    const batches = [];
    for await (const batch of source!()) batches.push(batch);

    expect(batches.map((b) => b.length)).toEqual([1000, 1]);
    expect(batches[1]).toEqual([{ betId: 'b9999', playerId: 'bob', amount: 7 }]);
    // The second page starts after the last bet id of the first one.
    expect(prisma.$queryRaw.mock.calls[2]).toContain('b0999');
  });
});
