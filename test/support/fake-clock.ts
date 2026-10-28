import { Clock } from '../../src/clock/clock.service';

/** Clock whose time only moves when a test sets it. Without an explicit time it follows the real clock. */
export class FakeClock extends Clock {
  private current?: Date;

  constructor(at?: Date) {
    super();
    this.current = at;
  }

  now(): Date {
    return this.current ?? new Date();
  }

  set(at: Date): void {
    this.current = at;
  }

  reset(): void {
    this.current = undefined;
  }
}
