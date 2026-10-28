import { ConfigType, registerAs } from '@nestjs/config';

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

export const tournamentsConfig = registerAs('tournaments', () => ({
  /** Delay after endsAt before finalizing, so in-flight bets for the last moments can land. */
  finalizeGraceMs: intFromEnv('FINALIZE_GRACE_MS', 5_000, 0),
  finalizeAttempts: intFromEnv('FINALIZE_ATTEMPTS', 10, 1),
  /** Base delay of the exponential backoff between finalize attempts. */
  finalizeBackoffMs: intFromEnv('FINALIZE_BACKOFF_MS', 5_000, 0),
  /** Upper bound for the finalize transaction (aggregating all bets of one tournament). */
  finalizeTimeoutMs: intFromEnv('FINALIZE_TIMEOUT_MS', 60_000, 1_000),
  /** How often the worker looks for overdue tournaments whose finalize job was never enqueued. */
  sweepEveryMs: intFromEnv('FINALIZE_SWEEP_EVERY_MS', 60_000, 1_000),
  sweepBatchSize: intFromEnv('FINALIZE_SWEEP_BATCH_SIZE', 100, 1),
  /** How long live leaderboard keys outlive endsAt (or the latest write, if later). */
  leaderboardTtlAfterEndSeconds: intFromEnv('LEADERBOARD_TTL_AFTER_END_SECONDS', 7 * 24 * 60 * 60, 1),
}));

export type TournamentsConfig = ConfigType<typeof tournamentsConfig>;
