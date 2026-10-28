import { applyDecorators } from '@nestjs/common';
import { IsISO8601, Matches } from 'class-validator';

/** ISO 8601 date-time with an explicit offset; without one, `new Date()` would use the server's local timezone. */
export const IsIsoDateTime = () =>
  applyDecorators(
    IsISO8601({ strict: true }),
    Matches(/^\d{4}-\d{2}-\d{2}T[^Z+-]+(Z|[+-]\d{2}:?\d{2})$/i, {
      message: '$property must be an ISO 8601 date-time with a timezone, e.g. 2026-06-04T12:30:00.000Z',
    }),
  );
