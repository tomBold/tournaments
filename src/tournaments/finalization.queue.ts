/** Also carries the leaderboard jobs; renaming the queue would orphan already scheduled finalize jobs. */
export const FINALIZATION_QUEUE = 'tournament-finalization';

export const FinalizationJob = {
  /** Delayed job, one per tournament, scheduled for endsAt + grace. */
  Finalize: 'finalize',
  /** Periodic safety net for tournaments whose finalize job was never enqueued. */
  Sweep: 'sweep',
  /** Periodic drain of leaderboard_outbox into Redis. */
  RelayOutbox: 'relay-leaderboard-outbox',
  /** Periodic rebuild of live leaderboards that are behind Postgres. */
  RepairLeaderboards: 'repair-leaderboards',
} as const;

export interface FinalizationJobData {
  tournamentId: string;
}

export const finalizeJobId = (tournamentId: string) => `finalize_${tournamentId}`;
