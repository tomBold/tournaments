import { TournamentsConfig } from '../../src/tournaments/tournaments.config';

/** Deliberately different from the defaults, so tests prove the injected values are the ones used. */
export const testConfig: TournamentsConfig = {
  finalizeGraceMs: 1_000,
  finalizeAttempts: 3,
  finalizeBackoffMs: 200,
  finalizeTimeoutMs: 2_000,
  sweepEveryMs: 15_000,
  sweepBatchSize: 25,
  leaderboardTtlAfterEndSeconds: 3_600,
};
