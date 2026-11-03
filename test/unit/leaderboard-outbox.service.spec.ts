import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LeaderboardOutboxService, RELAY_MAX_BATCHES } from '../../src/tournaments/leaderboard-outbox.service';
import { LeaderboardRepairService } from '../../src/tournaments/leaderboard-repair.service';
import { LeaderboardOutOfSyncError, LeaderboardService } from '../../src/tournaments/leaderboard.service';

const ENDS_AT = new Date('2030-06-30T00:00:00.000Z');
const row = (tournamentId: string, betId: string, status = 'OPEN') => ({
  tournament_id: tournamentId,
  bet_id: betId,
  player_id: `player_${betId}`,
  amount: 100,
  ends_at: ENDS_AT,
  status,
});

describe('LeaderboardOutboxService', () => {
  const tx = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown, _options?: unknown) => fn(tx)),
  };
  const leaderboard = { addBets: jest.fn() };
  const repair = { rebuild: jest.fn() };
  let service: LeaderboardOutboxService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn, _options) => fn(tx));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service = new LeaderboardOutboxService(
      prisma as unknown as PrismaService,
      leaderboard as unknown as LeaderboardService,
      repair as unknown as LeaderboardRepairService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('applies the outbox to Redis per tournament, then deletes the relayed rows', async () => {
    tx.$queryRaw.mockResolvedValueOnce([row('t1', 'b1'), row('t2', 'b2'), row('t1', 'b3')]);
    leaderboard.addBets.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service.relay()).resolves.toBe(1);

    expect(leaderboard.addBets.mock.calls).toEqual([
      [
        't1',
        ENDS_AT,
        [
          { betId: 'b1', playerId: 'player_b1', amount: 100 },
          { betId: 'b3', playerId: 'player_b3', amount: 100 },
        ],
      ],
      ['t2', ENDS_AT, [{ betId: 'b2', playerId: 'player_b2', amount: 100 }]],
    ]);
    const [, tournamentIds, betIds] = tx.$executeRaw.mock.calls[0];
    expect(tournamentIds).toEqual(['t1', 't2', 't1']);
    expect(betIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('drops rows of finalized tournaments without recreating their Redis keys', async () => {
    tx.$queryRaw.mockResolvedValueOnce([row('t1', 'b1', 'FINALIZED')]);

    await service.relay();

    expect(leaderboard.addBets).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows when Redis rejects a write, so the next run retries them', async () => {
    tx.$queryRaw.mockResolvedValueOnce([row('t1', 'b1')]);
    leaderboard.addBets.mockRejectedValue(new Error('Redis down'));

    await expect(service.relay()).rejects.toThrow('Redis down');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  const fullBatch = () => Array.from({ length: 1000 }, (_, i) => row('t1', `b${i}`));

  it('keeps draining while batches come back full', async () => {
    tx.$queryRaw.mockResolvedValueOnce(fullBatch()).mockResolvedValueOnce([row('t1', 'last')]);
    leaderboard.addBets.mockResolvedValue(0);

    await service.relay();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('yields after a bounded number of batches even when every batch is full', async () => {
    tx.$queryRaw.mockImplementation(async () => fullBatch());
    leaderboard.addBets.mockResolvedValue(0);

    await service.relay();

    expect(prisma.$transaction).toHaveBeenCalledTimes(RELAY_MAX_BATCHES);
  });

  it('rebuilds a partially lost leaderboard once, after its rows are committed', async () => {
    tx.$queryRaw.mockResolvedValueOnce([row('t1', 'b1'), row('t2', 'b2')]);
    leaderboard.addBets
      .mockRejectedValueOnce(new LeaderboardOutOfSyncError('t1'))
      .mockResolvedValueOnce(1);

    await expect(service.relay()).resolves.toBe(1);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(repair.rebuild.mock.calls).toEqual([['t1', ENDS_AT]]);
    expect(repair.rebuild.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
  });

  it('does nothing on an empty outbox', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);

    await expect(service.relay()).resolves.toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
