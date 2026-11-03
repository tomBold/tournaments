/**
 * Separate from the finalization queue, so a long outbox relay or rebuild never delays a finalize job: each
 * queue gets its own BullMQ worker.
 */
export const LEADERBOARD_QUEUE = 'leaderboard-maintenance';

export const LeaderboardJob = {
  /** Periodic drain of leaderboard_outbox into Redis. */
  RelayOutbox: 'relay-leaderboard-outbox',
  /** Periodic rebuild of live leaderboards that are behind Postgres. */
  RepairLeaderboards: 'repair-leaderboards',
} as const;
