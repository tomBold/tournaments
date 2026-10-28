import { Injectable } from '@nestjs/common';

/** Source of the current time, injected so tests can control it instead of patching `Date`. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
