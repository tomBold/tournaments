import { Matches } from 'class-validator';

export const IsCurrencyCode = () =>
  Matches(/^[A-Z]{3}$/, { message: '$property must be a 3-letter ISO 4217 code' });
