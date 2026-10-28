process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/tournaments_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
