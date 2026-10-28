import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClockModule } from './clock/clock.module';
import { PrismaModule } from './prisma/prisma.module';
import { bullConnectionFromUrl } from './redis/redis-connection';
import { RedisModule } from './redis/redis.module';

/** Infrastructure shared by the API and the worker process. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ClockModule,
    PrismaModule,
    RedisModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: bullConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
      }),
    }),
  ],
})
export class CoreModule {}
