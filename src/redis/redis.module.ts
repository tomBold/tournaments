import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      // A bet is already committed in Postgres when its Redis write runs; with ioredis' default of
      // 20 retries a Redis outage would hang each request instead of returning a retryable 500.
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: 2 }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
