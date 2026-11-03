import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '../../src/tournaments/leaderboard-cursor';

const encodeRaw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('leaderboard cursor', () => {
  it.each([
    [{ offset: 0 }],
    [{ offset: 150 }],
    [{ offset: 3, after: { placement: 2, playerId: 'p "1" ü' } }],
  ])('round-trips %j', (cursor) => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['not base64 JSON', '%%%'],
    ['a negative offset', encodeRaw({ o: -1 })],
    ['a fractional offset', encodeRaw({ o: 1.5 })],
    ['a keyset without a player id', encodeRaw({ o: 1, p: 1 })],
    ['a zero placement', encodeRaw({ o: 1, p: 0, id: 'a' })],
    ['JSON null', encodeRaw(null)],
  ])('rejects %s', (_case, raw) => {
    expect(() => decodeCursor(raw)).toThrow(BadRequestException);
  });
});
