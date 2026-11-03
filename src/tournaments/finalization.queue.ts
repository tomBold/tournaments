export const FINALIZATION_QUEUE = 'tournament-finalization';

export const FinalizationJob = {
  /** Delayed job, one per tournament, scheduled for endsAt + grace. */
  Finalize: 'finalize',
  /** Periodic safety net for tournaments whose finalize job was never enqueued. */
  Sweep: 'sweep',
} as const;

export interface FinalizationJobData {
  tournamentId: string;
}

export const finalizeJobId = (tournamentId: string) => `finalize_${tournamentId}`;
