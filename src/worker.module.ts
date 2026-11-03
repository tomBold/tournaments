import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { FinalizationProcessor } from './tournaments/finalization.processor';
import { LeaderboardProcessor } from './tournaments/leaderboard.processor';
import { LEADERBOARD_QUEUE } from './tournaments/leaderboard.queue';
import { TournamentsModule } from './tournaments/tournaments.module';

@Module({
  imports: [CoreModule, TournamentsModule, BullModule.registerQueue({ name: LEADERBOARD_QUEUE })],
  providers: [FinalizationProcessor, LeaderboardProcessor],
})
export class WorkerModule {}
