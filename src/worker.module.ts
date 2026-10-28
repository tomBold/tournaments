import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { FinalizationProcessor } from './tournaments/finalization.processor';
import { TournamentsModule } from './tournaments/tournaments.module';

@Module({
  imports: [CoreModule, TournamentsModule],
  providers: [FinalizationProcessor],
})
export class WorkerModule {}
