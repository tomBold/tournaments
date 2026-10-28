import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Clock } from '../clock/clock.service';
import { REDIS } from '../redis/redis.module';
import { tournamentsConfig, TournamentsConfig } from './tournaments.config';

export interface LeaderboardEntry {
  placement: number;
  playerId: string;
  score: number;
}

// Atomic per-tournament idempotency: the score is only incremented the first time a bet id is seen.
const ADD_BET_LUA = `
if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then
  redis.call('ZINCRBY', KEYS[2], ARGV[3], ARGV[2])
  redis.call('EXPIREAT', KEYS[1], ARGV[4])
  redis.call('EXPIREAT', KEYS[2], ARGV[4])
  return 1
end
return 0
`;

type RedisWithLeaderboard = Redis & {
  leaderboardAddBet(
    seenKey: string,
    boardKey: string,
    betId: string,
    playerId: string,
    amount: number,
    expireAt: number,
  ): Promise<number>;
};

@Injectable()
export class LeaderboardService {
  private readonly redis: RedisWithLeaderboard;

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(tournamentsConfig.KEY) private readonly config: TournamentsConfig,
    private readonly clock: Clock,
  ) {
    redis.defineCommand('leaderboardAddBet', { numberOfKeys: 2, lua: ADD_BET_LUA });
    this.redis = redis as RedisWithLeaderboard;
  }

  // Hash tags keep both keys of a tournament in the same Redis Cluster slot.
  static boardKey(tournamentId: string): string {
    return `tournament:{${tournamentId}}:leaderboard`;
  }

  static seenKey(tournamentId: string): string {
    return `tournament:{${tournamentId}}:bets`;
  }

  /** Returns true if the bet was applied, false if it had already been counted. */
  async addBet(
    tournamentId: string,
    endsAt: Date,
    betId: string,
    playerId: string,
    amount: number,
  ): Promise<boolean> {
    const expireAt =
      Math.floor(Math.max(endsAt.getTime(), this.clock.now().getTime()) / 1000) +
      this.config.leaderboardTtlAfterEndSeconds;
    const applied = await this.redis.leaderboardAddBet(
      LeaderboardService.seenKey(tournamentId),
      LeaderboardService.boardKey(tournamentId),
      betId,
      playerId,
      amount,
      expireAt,
    );
    return applied === 1;
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
    const key = LeaderboardService.boardKey(tournamentId);
    const replies = await this.redis
      .multi()
      .zcard(key)
      .zrevrange(key, offset, offset + limit - 1, 'WITHSCORES')
      .exec();
    if (!replies) throw new Error('Redis transaction aborted');
    const failed = replies.find(([err]) => err);
    if (failed) throw failed[0];
    const total = replies[0][1] as number;
    const raw = replies[1][1] as string[];

    const rows: { playerId: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      rows.push({ playerId: raw[i], score: Number(raw[i + 1]) });
    }
    if (rows.length === 0) return { total, items: [] };

    const higherThanFirst = await this.redis.zcount(key, `(${rows[0].score}`, '+inf');

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
}
