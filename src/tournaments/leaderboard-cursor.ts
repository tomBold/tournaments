import { BadRequestException } from '@nestjs/common';

/**
 * Opaque page cursor. `offset` alone works for both sources (Redis ranges are cheap at any offset); `after`
 * is the last row of a final page, so the next one is read by keyset instead of skipping rows in Postgres.
 * A cursor from a live page keeps working after the tournament is finalized, via its offset.
 */
export interface LeaderboardCursor {
  offset: number;
  after?: { placement: number; playerId: string };
}

export function encodeCursor(cursor: LeaderboardCursor): string {
  const { offset, after } = cursor;
  return Buffer.from(
    JSON.stringify(after ? { o: offset, p: after.placement, id: after.playerId } : { o: offset }),
  ).toString('base64url');
}

export function decodeCursor(raw: string): LeaderboardCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  const { o, p, id } = (parsed ?? {}) as Record<string, unknown>;
  if (!Number.isSafeInteger(o) || (o as number) < 0) throw new BadRequestException('Invalid cursor');
  if (p === undefined && id === undefined) return { offset: o as number };
  if (!Number.isSafeInteger(p) || (p as number) < 1 || typeof id !== 'string') {
    throw new BadRequestException('Invalid cursor');
  }
  return { offset: o as number, after: { placement: p as number, playerId: id } };
}
