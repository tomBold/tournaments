import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Clock } from '../clock/clock.service';
import { REDIS } from '../redis/redis.module';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

export interface LeaderboardEntry {
  placement: number;
  playerId: string;
  score: number;
}

export interface LeaderboardBet {
  betId: string;
  playerId: string;
  amount: number;
}

/** Yields every counted bet of a tournament in batches; called once per rebuild pass. */
export type LeaderboardBetSource = () => AsyncIterable<LeaderboardBet[]>;

/** Redis holds only one of a tournament's two keys; the leaderboard has to be rebuilt from Postgres. */
export class LeaderboardOutOfSyncError extends Error {
  constructor(readonly tournamentId: string) {
    super(`Live leaderboard of tournament ${tournamentId} is partially lost and needs a rebuild`);
  }
}

/** Temporary rebuild keys only need to outlive one rebuild; a crashed rebuild leaves nothing behind for long. */
const REBUILD_KEY_TTL_SECONDS = 60 * 60;

// Atomic per-tournament idempotency: a score is only incremented the first time its bet id is seen.
// Every write creates or extends both keys together, so exactly one of them existing means Redis lost the
// other; writing then would build a board from new bets alone, so the script refuses with -1.
// ARGV: expireAt, then (betId, playerId, amount) per bet.
const ADD_BETS_LUA = `
if redis.call('EXISTS', KEYS[1]) ~= redis.call('EXISTS', KEYS[2]) then
  return -1
end
local applied = 0
for i = 2, #ARGV, 3 do
  if redis.call('SADD', KEYS[1], ARGV[i]) == 1 then
    redis.call('ZINCRBY', KEYS[2], ARGV[i + 2], ARGV[i + 1])
    applied = applied + 1
  end
end
if applied > 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[1])
  redis.call('EXPIREAT', KEYS[2], ARGV[1])
end
return applied
`;

// One atomic read so the page, the total and the first row's tie offset come from the same snapshot.
const GET_PAGE_LUA = `
local total = redis.call('ZCARD', KEYS[1])
local rows = redis.call('ZREVRANGE', KEYS[1], ARGV[1], ARGV[2], 'WITHSCORES')
local higher = 0
if #rows > 0 then
  higher = redis.call('ZCOUNT', KEYS[1], '(' .. rows[2], '+inf')
end
return {total, higher, rows}
`;

// Atomically moves rebuilt keys (KEYS[1..2]) over the live ones (KEYS[3..4]). A rebuilt key that was never
// created means the tournament has no bets, so the live key is removed.
const REPLACE_LUA = `
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    redis.call('RENAME', KEYS[i], KEYS[i + 2])
    redis.call('EXPIREAT', KEYS[i + 2], ARGV[1])
  else
    redis.call('DEL', KEYS[i + 2])
  end
end
return 1
`;

type RedisWithLeaderboard = Redis & {
  leaderboardAddBets(
    seenKey: string,
    boardKey: string,
    expireAt: number,
    ...betArgs: (string | number)[]
  ): Promise<number>;
  leaderboardGetPage(
    boardKey: string,
    start: number,
    stop: number,
  ): Promise<[total: number, higherThanFirst: number, rows: string[]]>;
  leaderboardReplace(
    rebuiltSeenKey: string,
    rebuiltBoardKey: string,
    seenKey: string,
    boardKey: string,
    expireAt: number,
  ): Promise<number>;
};

@Injectable()
export class LeaderboardService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaderboardService.name);
  private readonly redis: RedisWithLeaderboard;

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
    private readonly clock: Clock,
  ) {
    redis.defineCommand('leaderboardAddBets', { numberOfKeys: 2, lua: ADD_BETS_LUA });
    redis.defineCommand('leaderboardGetPage', { numberOfKeys: 1, lua: GET_PAGE_LUA });
    redis.defineCommand('leaderboardReplace', { numberOfKeys: 4, lua: REPLACE_LUA });
    this.redis = redis as RedisWithLeaderboard;
  }

  // Hash tags keep all keys of a tournament in the same Redis Cluster slot.
  static boardKey(tournamentId: string): string {
    return `tournament:{${tournamentId}}:leaderboard`;
  }

  static seenKey(tournamentId: string): string {
    return `tournament:{${tournamentId}}:bets`;
  }

  /**
   * An evicted leaderboard shows wrong scores until it is rebuilt from Postgres. Managed Redis often blocks
   * CONFIG; then we can't tell.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const [, policy] = (await this.redis.config('GET', 'maxmemory-policy')) as string[];
      if (policy && policy !== 'noeviction') {
        this.logger.warn(
          `Redis maxmemory-policy is "${policy}"; use "noeviction" so live leaderboards are never evicted`,
        );
      }
    } catch (err) {
      this.logger.debug(`Could not read Redis maxmemory-policy: ${(err as Error).message}`);
    }
  }

  /**
   * Returns true if the bet was applied, false if it had already been counted.
   * Throws LeaderboardOutOfSyncError, without writing, when Redis lost one of the tournament's keys.
   */
  async addBet(
    tournamentId: string,
    endsAt: Date,
    betId: string,
    playerId: string,
    amount: number,
  ): Promise<boolean> {
    return (await this.addBets(tournamentId, endsAt, [{ betId, playerId, amount }])) === 1;
  }

  /** Batch form of `addBet` for one tournament. Returns how many bets were newly applied. */
  async addBets(tournamentId: string, endsAt: Date, bets: LeaderboardBet[]): Promise<number> {
    const applied = await this.applyBets(
      LeaderboardService.seenKey(tournamentId),
      LeaderboardService.boardKey(tournamentId),
      bets,
      this.expireAt(endsAt),
    );
    if (applied < 0) throw new LeaderboardOutOfSyncError(tournamentId);
    return applied;
  }

  /**
   * Replaces the live leaderboard with one built from `loadBets`, without the board ever appearing empty.
   * The rebuild is written to temporary keys and swapped in atomically. Bets that reach the old keys while the
   * copy runs are discarded by the swap, so the bets are replayed onto the new keys afterwards; that second
   * pass is idempotent and only adds what the first one missed.
   */
  async rebuild(tournamentId: string, endsAt: Date, loadBets: LeaderboardBetSource): Promise<void> {
    const token = randomUUID();
    const rebuiltSeen = `tournament:{${tournamentId}}:rebuild:${token}:bets`;
    const rebuiltBoard = `tournament:{${tournamentId}}:rebuild:${token}:leaderboard`;
    const seen = LeaderboardService.seenKey(tournamentId);
    const board = LeaderboardService.boardKey(tournamentId);
    const tempExpireAt = Math.floor(this.clock.now().getTime() / 1000) + REBUILD_KEY_TTL_SECONDS;

    for await (const batch of loadBets()) {
      await this.applyBets(rebuiltSeen, rebuiltBoard, batch, tempExpireAt);
    }
    await this.redis.leaderboardReplace(rebuiltSeen, rebuiltBoard, seen, board, this.expireAt(endsAt));
    for await (const batch of loadBets()) {
      await this.addBets(tournamentId, endsAt, batch);
    }
  }

  /**
   * False when Redis holds fewer bets than Postgres has counted, or the board is gone while bets exist.
   * A bet committed to Postgres whose Redis write is still in flight also reads as out of sync; rebuilding
   * then is harmless.
   */
  async isInSync(tournamentId: string, countedBets: number): Promise<boolean> {
    if (countedBets === 0) return true;
    const replies = await this.redis
      .multi()
      .exists(LeaderboardService.boardKey(tournamentId))
      .scard(LeaderboardService.seenKey(tournamentId))
      .exec();
    if (!replies) throw new Error('Redis transaction aborted');
    const failed = replies.find(([err]) => err);
    if (failed) throw failed[0];
    const [[, boardExists], [, seenBets]] = replies as [unknown, number][];
    return boardExists === 1 && seenBets >= countedBets;
  }

  /** Drops a tournament's live keys once its leaderboard is served from Postgres. */
  async clear(tournamentId: string): Promise<void> {
    await this.redis.del(LeaderboardService.seenKey(tournamentId), LeaderboardService.boardKey(tournamentId));
  }

  /**
   * Page of the live leaderboard, score DESC. Placements use competition ranking ("1, 1, 3"):
   * tied players share a placement equal to 1 + the number of players with a strictly higher score.
   */
  async getPage(
    tournamentId: string,
    limit: number,
    offset: number,
  ): Promise<{ total: number; items: LeaderboardEntry[] }> {
    const [total, higherThanFirst, raw] = await this.redis.leaderboardGetPage(
      LeaderboardService.boardKey(tournamentId),
      offset,
      offset + limit - 1,
    );

    const rows: { playerId: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      rows.push({ playerId: raw[i], score: Number(raw[i + 1]) });
    }

    const items: LeaderboardEntry[] = [];
    rows.forEach((row, i) => {
      const placement =
        i === 0
          ? higherThanFirst + 1
          : row.score === rows[i - 1].score
            ? items[i - 1].placement
            : offset + i + 1;
      items.push({ placement, playerId: row.playerId, score: row.score });
    });
    return { total, items };
  }

  private expireAt(endsAt: Date): number {
    return (
      Math.floor(Math.max(endsAt.getTime(), this.clock.now().getTime()) / 1000) +
      this.config.leaderboardTtlAfterEndSeconds
    );
  }

  private async applyBets(
    seenKey: string,
    boardKey: string,
    bets: LeaderboardBet[],
    expireAt: number,
  ): Promise<number> {
    if (bets.length === 0) return 0;
    const args = bets.flatMap((b) => [b.betId, b.playerId, b.amount]);
    return this.redis.leaderboardAddBets(seenKey, boardKey, expireAt, ...args);
  }
}
