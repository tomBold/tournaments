import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './clock.service';

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
