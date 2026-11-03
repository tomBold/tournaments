import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';
import { FINALIZATION_QUEUE } from './finalization.queue';
import { FinalizationService } from './finalization.service';
import { LeaderboardOutboxService } from './leaderboard-outbox.service';
import { LeaderboardRepairService } from './leaderboard-repair.service';
import { LeaderboardService } from './leaderboard.service';
import { tournamentsConfig } from './tournaments.config';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

const tournamentsConfigModule = ConfigModule.forFeature(tournamentsConfig);

@Module({
  imports: [tournamentsConfigModule, BullModule.registerQueue({ name: FINALIZATION_QUEUE })],
  controllers: [TournamentsController, BetsController],
  providers: [
    TournamentsService,
    BetsService,
    LeaderboardService,
    LeaderboardOutboxService,
    LeaderboardRepairService,
    FinalizationService,
  ],
  exports: [
    FinalizationService,
    LeaderboardOutboxService,
    LeaderboardRepairService,
    BullModule,
    tournamentsConfigModule,
  ],
})
export class TournamentsModule {}
