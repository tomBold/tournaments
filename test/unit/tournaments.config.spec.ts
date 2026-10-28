import { tournamentsConfig } from '../../src/tournaments/tournaments.config';

describe('tournamentsConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('uses defaults when variables are unset', () => {
    delete process.env.FINALIZE_GRACE_MS;
    delete process.env.FINALIZE_SWEEP_EVERY_MS;

    expect(tournamentsConfig()).toMatchObject({ finalizeGraceMs: 5_000, sweepEveryMs: 60_000 });
  });

  it('reads values from the environment', () => {
    process.env.FINALIZE_GRACE_MS = '250';
    process.env.FINALIZE_ATTEMPTS = '4';

    expect(tournamentsConfig()).toMatchObject({ finalizeGraceMs: 250, finalizeAttempts: 4 });
  });

  it.each([
    ['FINALIZE_GRACE_MS', 'abc'],
    ['FINALIZE_GRACE_MS', '-1'],
    ['FINALIZE_ATTEMPTS', '0'],
    ['FINALIZE_SWEEP_BATCH_SIZE', '1.5'],
  ])('fails fast on invalid %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => tournamentsConfig()).toThrow(name);
  });
});
