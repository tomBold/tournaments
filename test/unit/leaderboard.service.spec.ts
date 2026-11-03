import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { LeaderboardBet, LeaderboardService } from '../../src/tournaments/leaderboard.service';
import { FakeClock } from '../support/fake-clock';
import { testConfig } from '../support/test-config';

/** Stand-in for the service's Lua commands and the few plain commands it uses. `board` is already score DESC. */
function fakeRedis(board: [playerId: string, score: number][]) {
  const syncState = { boardExists: 1, seenBets: 0 };
  const multi = {
    exists: () => multi,
    scard: () => multi,
    exec: async () => [
      [null, syncState.boardExists],
      [null, syncState.seenBets],
    ],
  };
  return {
    syncState,
    defineCommand: jest.fn(),
    leaderboardGetPage: jest.fn(async (_key: string, start: number, stop: number) => {
      const page = board.slice(start, stop + 1);
      const higher = page.length ? board.filter(([, score]) => score > page[0][1]).length : 0;
      return [board.length, higher, page.flatMap(([id, score]) => [id, String(score)])];
    }),
    leaderboardAddBets: jest.fn().mockResolvedValue(1),
    leaderboardReplace: jest.fn().mockResolvedValue(1),
    multi: () => multi,
    del: jest.fn(),
    config: jest.fn(),
  };
}

const serviceWith = (redis: ReturnType<typeof fakeRedis>, clock = new FakeClock()) =>
  new LeaderboardService(redis as unknown as Redis, testConfig, clock);

describe('LeaderboardService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registers its Lua scripts with their key counts', () => {
    const redis = fakeRedis([]);
    serviceWith(redis);

    expect(redis.defineCommand.mock.calls.map(([name, def]) => [name, def.numberOfKeys])).toEqual([
      ['leaderboardAddBets', 2],
      ['leaderboardGetPage', 1],
      ['leaderboardReplace', 4],
    ]);
  });

  describe('getPage', () => {
    const board: [string, number][] = [
      ['p1', 600],
      ['p4', 500],
      ['p3', 500],
      ['p2', 500],
      ['p5', 100],
    ];

    it('gives tied players the same placement (1, 2, 2, 2, 5)', async () => {
      const { items, total } = await serviceWith(fakeRedis(board)).getPage('t1', 10, 0);

      expect(total).toBe(5);
      expect(items.map((i) => i.placement)).toEqual([1, 2, 2, 2, 5]);
    });

    it('keeps absolute placements when a page starts in the middle of a tie', async () => {
      const { items } = await serviceWith(fakeRedis(board)).getPage('t1', 3, 2);

      expect(items).toEqual([
        { placement: 2, playerId: 'p3', score: 500 },
        { placement: 2, playerId: 'p2', score: 500 },
        { placement: 5, playerId: 'p5', score: 100 },
      ]);
    });

    it('returns an empty page past the end', async () => {
      await expect(serviceWith(fakeRedis(board)).getPage('t1', 10, 50)).resolves.toEqual({
        total: 5,
        items: [],
      });
    });

    it('reads the page in one atomic script call', async () => {
      const redis = fakeRedis(board);
      await serviceWith(redis).getPage('t1', 3, 2);

      expect(redis.leaderboardGetPage).toHaveBeenCalledWith('tournament:{t1}:leaderboard', 2, 4);
    });
  });

  describe('addBet', () => {
    it('expires keys the configured time after endsAt, in the same cluster slot', async () => {
      const clock = new FakeClock(new Date('2030-06-01T00:00:00.000Z'));
      const endsAt = new Date('2030-06-30T00:00:00.000Z');
      const redis = fakeRedis([]);

      await expect(serviceWith(redis, clock).addBet('t1', endsAt, 'b1', 'alice', 250)).resolves.toBe(
        true,
      );

      expect(redis.leaderboardAddBets).toHaveBeenCalledWith(
        'tournament:{t1}:bets',
        'tournament:{t1}:leaderboard',
        endsAt.getTime() / 1000 + testConfig.leaderboardTtlAfterEndSeconds,
        'b1',
        'alice',
        250,
      );
    });

    it('uses the current time when a bet is written after endsAt', async () => {
      const now = new Date('2030-07-05T00:00:00.000Z');
      const redis = fakeRedis([]);

      await serviceWith(redis, new FakeClock(now)).addBet(
        't1',
        new Date('2030-06-30T00:00:00.000Z'),
        'b1',
        'alice',
        250,
      );

      expect(redis.leaderboardAddBets.mock.calls[0][2]).toBe(
        now.getTime() / 1000 + testConfig.leaderboardTtlAfterEndSeconds,
      );
    });

    it('returns false when the bet was already counted', async () => {
      const redis = fakeRedis([]);
      redis.leaderboardAddBets.mockResolvedValue(0);

      await expect(serviceWith(redis).addBet('t1', new Date(), 'b1', 'alice', 250)).resolves.toBe(false);
    });
  });

  describe('rebuild', () => {
    const now = new Date('2030-06-15T00:00:00.000Z');
    const endsAt = new Date('2030-06-30T00:00:00.000Z');
    const liveExpireAt = endsAt.getTime() / 1000 + testConfig.leaderboardTtlAfterEndSeconds;
    const batches: LeaderboardBet[][] = [
      [
        { betId: 'b1', playerId: 'alice', amount: 100 },
        { betId: 'b2', playerId: 'bob', amount: 200 },
      ],
      [{ betId: 'b3', playerId: 'alice', amount: 50 }],
    ];
    const source = jest.fn(async function* () {
      yield* batches;
    });

    it('builds temporary keys, swaps them in, then replays the bets onto the live keys', async () => {
      const redis = fakeRedis([]);

      await serviceWith(redis, new FakeClock(now)).rebuild('t1', endsAt, source);

      const [tempSeen, tempBoard] = redis.leaderboardReplace.mock.calls[0];
      expect(tempSeen).toMatch(/^tournament:\{t1\}:rebuild:.+:bets$/);
      expect(tempBoard).toMatch(/^tournament:\{t1\}:rebuild:.+:leaderboard$/);
      expect(redis.leaderboardReplace).toHaveBeenCalledWith(
        tempSeen,
        tempBoard,
        'tournament:{t1}:bets',
        'tournament:{t1}:leaderboard',
        liveExpireAt,
      );

      const keysWritten = redis.leaderboardAddBets.mock.calls.map(([seen]) => seen);
      expect(keysWritten).toEqual([tempSeen, tempSeen, 'tournament:{t1}:bets', 'tournament:{t1}:bets']);
      expect(redis.leaderboardAddBets.mock.calls[0]).toEqual([
        tempSeen,
        tempBoard,
        now.getTime() / 1000 + 3600,
        'b1',
        'alice',
        100,
        'b2',
        'bob',
        200,
      ]);
      expect(source).toHaveBeenCalledTimes(2);
    });

    it('swaps in an empty leaderboard when the tournament has no bets', async () => {
      const redis = fakeRedis([]);

      await serviceWith(redis, new FakeClock(now)).rebuild('t1', endsAt, async function* () {});

      expect(redis.leaderboardAddBets).not.toHaveBeenCalled();
      expect(redis.leaderboardReplace).toHaveBeenCalledTimes(1);
    });
  });

  describe('isInSync', () => {
    it.each([
      ['in sync', 1, 3, 3, true],
      ['ahead of Postgres (bet committed after the count was read)', 1, 4, 3, true],
      ['missing seen bets', 1, 2, 3, false],
      ['board evicted but seen bets kept', 0, 3, 3, false],
    ])('%s', async (_case, boardExists, seenBets, counted, expected) => {
      const redis = fakeRedis([]);
      Object.assign(redis.syncState, { boardExists, seenBets });

      await expect(serviceWith(redis).isInSync('t1', counted)).resolves.toBe(expected);
    });

    it('treats a tournament without bets as in sync', async () => {
      const redis = fakeRedis([]);
      Object.assign(redis.syncState, { boardExists: 0, seenBets: 0 });

      await expect(serviceWith(redis).isInSync('t1', 0)).resolves.toBe(true);
    });
  });

  it('clear deletes both live keys', async () => {
    const redis = fakeRedis([]);

    await serviceWith(redis).clear('t1');

    expect(redis.del).toHaveBeenCalledWith('tournament:{t1}:bets', 'tournament:{t1}:leaderboard');
  });

  describe('eviction policy check', () => {
    it('warns when Redis may evict keys', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const redis = fakeRedis([]);
      redis.config.mockResolvedValue(['maxmemory-policy', 'allkeys-lru']);

      await serviceWith(redis).onApplicationBootstrap();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('allkeys-lru'));
    });

    it('stays quiet with noeviction', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const redis = fakeRedis([]);
      redis.config.mockResolvedValue(['maxmemory-policy', 'noeviction']);

      await serviceWith(redis).onApplicationBootstrap();

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not fail startup when CONFIG is disabled (managed Redis)', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation();
      const redis = fakeRedis([]);
      redis.config.mockRejectedValue(new Error("ERR unknown command 'CONFIG'"));

      await expect(serviceWith(redis).onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});
