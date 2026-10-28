import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { TournamentsModule } from './tournaments/tournaments.module';

@Module({
  imports: [CoreModule, TournamentsModule],
})
export class AppModule {}
