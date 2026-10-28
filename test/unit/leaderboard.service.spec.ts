import Redis from 'ioredis';
import { LeaderboardService } from '../../src/tournaments/leaderboard.service';
import { FakeClock } from '../support/fake-clock';
import { testConfig } from '../support/test-config';

/** In-memory stand-in for the few Redis sorted-set commands the service uses. `board` is already score DESC. */
function fakeRedis(board: [playerId: string, score: number][]) {
  const queued: (() => unknown)[] = [];
  const multi = {
    zcard() {
      queued.push(() => board.length);
      return multi;
    },
    zrevrange(_key: string, start: number, stop: number) {
      queued.push(() => board.slice(start, stop + 1).flatMap(([id, score]) => [id, String(score)]));
      return multi;
    },
    async exec() {
      return queued.splice(0).map((run) => [null, run()]);
    },
  };
  return {
    defineCommand: jest.fn(),
    multi: () => multi,
    zcount: jest.fn(async (_key: string, min: string) => {
      const exclusiveMin = Number(min.slice(1));
      return board.filter(([, score]) => score > exclusiveMin).length;
    }),
    leaderboardAddBet: jest.fn().mockResolvedValue(1),
  };
}

const serviceWith = (redis: ReturnType<typeof fakeRedis>, clock = new FakeClock()) =>
  new LeaderboardService(redis as unknown as Redis, testConfig, clock);

describe('LeaderboardService', () => {
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
      const redis = fakeRedis(board);

      await expect(serviceWith(redis).getPage('t1', 10, 50)).resolves.toEqual({ total: 5, items: [] });
      expect(redis.zcount).not.toHaveBeenCalled();
    });
  });

  describe('addBet', () => {
    it('registers the idempotent Lua script once', () => {
      const redis = fakeRedis([]);
      serviceWith(redis);

      expect(redis.defineCommand).toHaveBeenCalledWith(
        'leaderboardAddBet',
        expect.objectContaining({ numberOfKeys: 2 }),
      );
    });

    it('expires keys the configured time after endsAt, in the same cluster slot', async () => {
      const clock = new FakeClock(new Date('2030-06-01T00:00:00.000Z'));
      const endsAt = new Date('2030-06-30T00:00:00.000Z');
      const redis = fakeRedis([]);

      await expect(serviceWith(redis, clock).addBet('t1', endsAt, 'b1', 'alice', 250)).resolves.toBe(
        true,
      );

      expect(redis.leaderboardAddBet).toHaveBeenCalledWith(
        'tournament:{t1}:bets',
        'tournament:{t1}:leaderboard',
        'b1',
        'alice',
        250,
        endsAt.getTime() / 1000 + testConfig.leaderboardTtlAfterEndSeconds,
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

      expect(redis.leaderboardAddBet.mock.calls[0][5]).toBe(
        now.getTime() / 1000 + testConfig.leaderboardTtlAfterEndSeconds,
      );
    });

    it('returns false when the bet was already counted', async () => {
      const redis = fakeRedis([]);
      redis.leaderboardAddBet.mockResolvedValue(0);

      await expect(serviceWith(redis).addBet('t1', new Date(), 'b1', 'alice', 250)).resolves.toBe(false);
    });
  });
});
