import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { HealthModule } from './health/health.module';
import { TournamentsModule } from './tournaments/tournaments.module';

@Module({
  imports: [CoreModule, HealthModule, TournamentsModule],
})
export class AppModule {}
