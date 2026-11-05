import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { TournamentsModule } from './tournaments/tournaments.module';
import { UiModule } from './ui/ui.module';

@Module({
  imports: [CoreModule, TournamentsModule, UiModule],
})
export class AppModule {}
