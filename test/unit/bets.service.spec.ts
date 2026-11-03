import { ConflictException, Logger, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BetsService } from '../../src/tournaments/bets.service';
import { LeaderboardService } from '../../src/tournaments/leaderboard.service';
import { FakeClock } from '../support/fake-clock';
import { testConfig } from '../support/test-config';

const dto = {
  externalBetId: 'bet_1',
  playerId: 'player_42',
  amount: 250,
  currency: 'USD',
  createdAt: '2030-06-04T12:30:00.000Z',
};
const storedBet = {
  id: 'b1',
  player_id: dto.playerId,
  amount: dto.amount,
  currency: dto.currency,
  created_at: new Date(dto.createdAt),
};
const endsAt = new Date('2030-06-30T00:00:00.000Z');
/** Shortly after the bet was created, so the late-bet check is skipped unless a test moves the clock. */
const JUST_AFTER_BET = new Date(new Date(dto.createdAt).getTime() + 100);

describe('BetsService', () => {
  // Each $queryRaw call inside the transaction returns the next queued result, in SQL order:
  // insert bet -> (select existing bet, if the insert was a no-op) -> candidate tournaments
  // -> (re-read under the tournament locks -> score limit check -> insert tournament_bets + outbox).
  // $executeRaw takes the advisory locks: one shared lock per candidate, then the player lock.
  const tx = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown, _options?: unknown) => fn(tx)),
    $queryRaw: jest.fn(),
  };
  const leaderboard = { addBet: jest.fn() };
  let clock: FakeClock;
  let service: BetsService;

  /** Queues the candidate and locked re-read results for tournaments that are (still) open. */
  const queueTournaments = (candidates: string[], stillOpen = candidates) => {
    tx.$queryRaw
      .mockResolvedValueOnce(candidates.map((id) => ({ id })))
      .mockResolvedValueOnce(stillOpen.map((id) => ({ id, ends_at: endsAt })));
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn, _options) => fn(tx));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    clock = new FakeClock(JUST_AFTER_BET);
    service = new BetsService(
      prisma as unknown as PrismaService,
      leaderboard as unknown as LeaderboardService,
      testConfig,
      clock,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the transaction timeout independent of how long finalization takes', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]).mockResolvedValueOnce([]);

    await service.ingest(dto);

    const [, options] = prisma.$transaction.mock.calls[0] as [unknown, { timeout: number }];
    expect(options.timeout).toBe(10_000);
  });

  it('counts a new bet towards every matching tournament and updates each live leaderboard', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]);
    queueTournaments(['t1', 't2']);
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tournament_id: 't1' }, { tournament_id: 't2' }]);

    const result = await service.ingest(dto);

    expect(result).toEqual({
      betId: 'b1',
      externalBetId: 'bet_1',
      duplicate: false,
      countedTournamentIds: ['t1', 't2'],
    });
    // Two shared tournament locks, then the player lock.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(leaderboard.addBet).toHaveBeenCalledTimes(2);
    expect(leaderboard.addBet).toHaveBeenCalledWith('t1', endsAt, 'b1', 'player_42', 250);
    expect(leaderboard.addBet).toHaveBeenCalledWith('t2', endsAt, 'b1', 'player_42', 250);
  });

  it('writes the outbox rows in the same statement that counts the bet', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]);
    queueTournaments(['t1']);
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ tournament_id: 't1' }]);

    await service.ingest(dto);

    const [strings] = tx.$queryRaw.mock.calls[4] as [TemplateStringsArray];
    const sql = strings.join('?');
    expect(sql).toContain('INSERT INTO tournament_bets');
    expect(sql).toContain('INSERT INTO leaderboard_outbox');
  });

  it('skips a tournament that was closed between the first read and the lock', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]);
    queueTournaments(['t1'], []);

    const result = await service.ingest(dto);

    expect(result.countedTournamentIds).toEqual([]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  it('stores a bet that matches no tournament without counting it or taking any lock', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]).mockResolvedValueOnce([]);

    const result = await service.ingest(dto);

    expect(result).toMatchObject({ duplicate: false, countedTournamentIds: [] });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  it('reports a re-sent bet as a duplicate but still re-applies it to Redis (idempotent repair)', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([storedBet]);
    queueTournaments(['t1']);
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await service.ingest(dto);

    expect(result).toEqual({
      betId: 'b1',
      externalBetId: 'bet_1',
      duplicate: true,
      countedTournamentIds: [],
    });
    expect(leaderboard.addBet).toHaveBeenCalledWith('t1', endsAt, 'b1', 'player_42', 250);
  });

  it('still succeeds when Redis is down, leaving the update to the outbox relay', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]);
    queueTournaments(['t1']);
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ tournament_id: 't1' }]);
    leaderboard.addBet.mockRejectedValue(new Error('Connection is closed'));

    await expect(service.ingest(dto)).resolves.toMatchObject({ countedTournamentIds: ['t1'] });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('outbox relay'));
  });

  it('rejects a re-sent externalBetId with a different payload', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...storedBet, amount: 999 }]);

    await expect(service.ingest(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  it('rejects a bet that would push the player past the maximum score, before counting it anywhere', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]);
    queueTournaments(['t1']);
    tx.$queryRaw.mockResolvedValueOnce([{ tournament_id: 't1' }]);

    await expect(service.ingest(dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  it('does not touch Redis when the Postgres transaction fails', async () => {
    tx.$queryRaw.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.ingest(dto)).rejects.toThrow('connection lost');
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  describe('late bets', () => {
    it('skips the check for a bet created within the grace period', async () => {
      tx.$queryRaw.mockResolvedValueOnce([storedBet]).mockResolvedValueOnce([]);

      await service.ingest(dto);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('warns about finalized tournaments an older bet was never counted towards', async () => {
      clock.set(new Date('2030-07-15T00:00:00.000Z'));
      tx.$queryRaw.mockResolvedValueOnce([storedBet]).mockResolvedValueOnce([]);
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 't-finalized' }]);

      await expect(service.ingest(dto)).resolves.toMatchObject({ countedTournamentIds: [] });

      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('t-finalized'));
    });

    it('still succeeds when the late-bet check itself fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      clock.set(new Date('2030-07-15T00:00:00.000Z'));
      tx.$queryRaw.mockResolvedValueOnce([storedBet]).mockResolvedValueOnce([]);
      prisma.$queryRaw.mockRejectedValueOnce(new Error('timeout'));

      await expect(service.ingest(dto)).resolves.toMatchObject({ betId: 'b1' });
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });
});
