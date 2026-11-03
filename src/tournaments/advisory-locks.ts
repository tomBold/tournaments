/**
 * First key of Postgres two-key advisory locks (`pg_advisory_xact_lock(space, hashtext(id))`), so tournament and
 * player hashes can never collide. A hash collision within a space only makes two ids share a lock.
 */
export const LockSpace = {
  /** Bets hold it shared while counting into the tournament; finalization takes it exclusive to close it. */
  Tournament: 1,
  /** Serializes one player's concurrent bets for the score limit check. */
  Player: 2,
} as const;
