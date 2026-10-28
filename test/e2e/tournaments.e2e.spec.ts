import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { Clock } from '../../src/clock/clock.service';
import { configureApp } from '../../src/configure-app';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS } from '../../src/redis/redis.module';
import { FINALIZATION_QUEUE, finalizeJobId } from '../../src/tournaments/finalization.queue';
import { FinalizationService } from '../../src/tournaments/finalization.service';
import { FakeClock } from '../support/fake-clock';

describe('Tournaments (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: Redis;

  const WINDOW = { startsAt: '2099-06-01T00:00:00.000Z', endsAt: '2099-06-30T23:59:59.999Z' };
  const IN_WINDOW = '2099-06-04T12:30:00.000Z';
  const AFTER_END = new Date('2099-07-01T00:00:00.000Z');
  const clock = new FakeClock();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(REDIS);
  });

  beforeEach(async () => {
    clock.reset();
    await prisma.$executeRawUnsafe(
      'TRUNCATE tournament_results, tournament_bets, bets, tournaments CASCADE',
    );
    await redis.flushdb();
  });

  afterAll(async () => {
    await app.close();
  });

  const createTournament = async (body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: { name: 'June Cup', ...WINDOW, ...body },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  };

  let betSeq = 0;
  const postBet = (overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/bet',
      payload: {
        externalBetId: `bet_${++betSeq}`,
        playerId: 'player_42',
        amount: 250,
        currency: 'USD',
        createdAt: IN_WINDOW,
        ...overrides,
      },
    });

  const leaderboard = async (id: string, query = '') => {
    const res = await app.inject({ method: 'GET', url: `/tournaments/${id}/leaderboard${query}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  describe('bet ingestion', () => {
    it('counts a bet inside the window and stores it', async () => {
      const t = await createTournament();

      const res = await postBet({ externalBetId: 'bet_123456' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        externalBetId: 'bet_123456',
        duplicate: false,
        countedTournamentIds: [t.id],
      });
      expect(await prisma.bet.count()).toBe(1);
      expect((await leaderboard(t.id)).items).toEqual([
        { placement: 1, playerId: 'player_42', score: 250 },
      ]);
    });

    it('treats startsAt and endsAt as inclusive bounds', async () => {
      const t = await createTournament();

      await postBet({ playerId: 'a', createdAt: WINDOW.startsAt });
      await postBet({ playerId: 'b', createdAt: WINDOW.endsAt });
      await postBet({ playerId: 'c', createdAt: '2099-05-31T23:59:59.999Z' });
      await postBet({ playerId: 'd', createdAt: '2099-07-01T00:00:00.000Z' });

      const board = await leaderboard(t.id);
      expect(board.items.map((i: { playerId: string }) => i.playerId).sort()).toEqual(['a', 'b']);
    });

    it('stores but does not count bets outside any tournament or in another currency', async () => {
      const t = await createTournament();

      const outside = await postBet({ createdAt: '2100-01-01T00:00:00.000Z' });
      const eur = await postBet({ currency: 'EUR' });

      expect(outside.json().countedTournamentIds).toEqual([]);
      expect(eur.json().countedTournamentIds).toEqual([]);
      expect(await prisma.bet.count()).toBe(2);
      expect((await leaderboard(t.id)).total).toBe(0);
    });

    it('counts one bet towards every overlapping tournament', async () => {
      const june = await createTournament();
      const week = await createTournament({
        name: 'Week 1',
        startsAt: '2099-06-01T00:00:00.000Z',
        endsAt: '2099-06-07T23:59:59.999Z',
      });

      const res = await postBet();

      expect(res.json().countedTournamentIds.sort()).toEqual([june.id, week.id].sort());
      expect((await leaderboard(june.id)).items[0].score).toBe(250);
      expect((await leaderboard(week.id)).items[0].score).toBe(250);
    });

    it('rejects invalid payloads', async () => {
      await createTournament();
      for (const bad of [{ amount: 2.5 }, { amount: -1 }, { currency: 'usd' }, { createdAt: 'yesterday' }]) {
        expect((await postBet(bad)).statusCode).toBe(400);
      }
      expect(await prisma.bet.count()).toBe(0);
    });

    it('rejects createdAt without a timezone instead of guessing the server timezone', async () => {
      await createTournament();
      for (const createdAt of ['2099-06-04T12:30:00', '2099-06-04T12:30:00.000', '2099-06-04']) {
        expect((await postBet({ createdAt })).statusCode).toBe(400);
      }
      expect((await postBet({ createdAt: '2099-06-04T14:30:00+02:00' })).statusCode).toBe(200);
    });
  });

  describe('duplicate bets', () => {
    it('is idempotent: a re-sent bet succeeds without increasing the score', async () => {
      const t = await createTournament();

      const first = await postBet({ externalBetId: 'bet_dup' });
      const second = await postBet({ externalBetId: 'bet_dup' });

      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        betId: first.json().betId,
        duplicate: true,
        countedTournamentIds: [],
      });
      expect((await leaderboard(t.id)).items[0].score).toBe(250);
      expect(await prisma.tournamentBet.count()).toBe(1);
    });

    it('counts concurrent duplicates exactly once', async () => {
      const t = await createTournament();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => postBet({ externalBetId: 'bet_race' })),
      );

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(responses.filter((r) => !r.json().duplicate)).toHaveLength(1);
      expect((await leaderboard(t.id)).items[0].score).toBe(250);
    });

    it('repairs the live leaderboard when a retry follows a lost Redis write', async () => {
      const t = await createTournament();
      await postBet({ externalBetId: 'bet_retry' });
      await redis.flushdb();

      const retry = await postBet({ externalBetId: 'bet_retry' });

      expect(retry.json().duplicate).toBe(true);
      expect((await leaderboard(t.id)).items[0].score).toBe(250);
    });

    it('counts a re-sent bet towards a tournament created after it first arrived', async () => {
      await postBet({ externalBetId: 'bet_early' });
      const t = await createTournament();

      const res = await postBet({ externalBetId: 'bet_early' });

      expect(res.json()).toMatchObject({ duplicate: false, countedTournamentIds: [t.id] });
    });

    it('returns 409 when the same externalBetId arrives with a different payload', async () => {
      await createTournament();
      await postBet({ externalBetId: 'bet_x', amount: 100 });

      const res = await postBet({ externalBetId: 'bet_x', amount: 999 });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('leaderboard', () => {
    const seed = async (tournamentId: string, bets: [string, number][]) => {
      for (const [playerId, amount] of bets) await postBet({ playerId, amount });
      return tournamentId;
    };

    it('sorts by summed score DESC and shares placements on ties', async () => {
      const t = await createTournament();
      await seed(t.id, [
        ['alice', 100],
        ['bob', 500],
        ['alice', 300],
        ['carol', 400],
        ['dave', 50],
      ]);

      const board = await leaderboard(t.id);

      expect(board).toMatchObject({ source: 'live', total: 4, limit: 50, offset: 0 });
      expect(board.items).toEqual([
        { placement: 1, playerId: 'bob', score: 500 },
        { placement: 2, playerId: 'carol', score: 400 },
        { placement: 2, playerId: 'alice', score: 400 },
        { placement: 4, playerId: 'dave', score: 50 },
      ]);
    });

    it('paginates with limit/offset and keeps absolute placements', async () => {
      const t = await createTournament();
      await seed(t.id, [
        ['p1', 600],
        ['p2', 500],
        ['p3', 500],
        ['p4', 500],
        ['p5', 100],
      ]);

      // Full order is p1, then the 500 tie (p4, p3, p2), then p5.
      const page = await leaderboard(t.id, '?limit=3&offset=2');

      expect(page).toMatchObject({ total: 5, limit: 3, offset: 2 });
      expect(page.items).toEqual([
        { placement: 2, playerId: 'p3', score: 500 },
        { placement: 2, playerId: 'p2', score: 500 },
        { placement: 5, playerId: 'p5', score: 100 },
      ]);
    });

    it('validates query params and tournament id', async () => {
      const t = await createTournament();
      const bad = [
        `/tournaments/${t.id}/leaderboard?limit=0`,
        `/tournaments/${t.id}/leaderboard?limit=101`,
        `/tournaments/${t.id}/leaderboard?offset=-1`,
        `/tournaments/not-a-uuid/leaderboard`,
      ];
      for (const url of bad) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
      const missing = await app.inject({
        method: 'GET',
        url: '/tournaments/00000000-0000-4000-8000-000000000000/leaderboard',
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('tournaments', () => {
    it('rejects endsAt before startsAt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tournaments',
        payload: { name: 'Bad', startsAt: WINDOW.endsAt, endsAt: WINDOW.startsAt },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a tournament that has already ended', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tournaments',
        payload: { name: 'Past', startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2020-01-31T00:00:00.000Z' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects dates without a timezone', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tournaments',
        payload: { name: 'No TZ', startsAt: '2099-06-01T00:00:00', endsAt: '2099-06-30T00:00:00' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('schedules a delayed BullMQ finalize job for after endsAt', async () => {
      const t = await createTournament();

      const job = await app.get<Queue>(getQueueToken(FINALIZATION_QUEUE)).getJob(finalizeJobId(t.id));

      expect(job?.data).toEqual({ tournamentId: t.id });
      expect(await job?.getState()).toBe('delayed');
      expect(job!.timestamp + job!.opts.delay!).toBeGreaterThan(new Date(WINDOW.endsAt).getTime());
    });

    it('still creates the tournament when the finalize job cannot be enqueued', async () => {
      const queue = app.get<Queue>(getQueueToken(FINALIZATION_QUEUE));
      const add = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Redis down'));
      const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      const t = await createTournament();

      expect(add).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalled();
      expect(await prisma.tournament.count({ where: { id: t.id } })).toBe(1);
      add.mockRestore();
      logError.mockRestore();
    });
  });

  describe('finalization', () => {
    it('keeps the same tie order after finalization regardless of database locale', async () => {
      const t = await createTournament();
      for (const playerId of ['Bob', 'alice', 'Carl', 'bob']) await postBet({ playerId, amount: 100 });

      const live = (await leaderboard(t.id)).items.map((i: { playerId: string }) => i.playerId);
      clock.set(AFTER_END);
      await app.get(FinalizationService).finalize(t.id);
      const final = (await leaderboard(t.id)).items.map((i: { playerId: string }) => i.playerId);

      expect(final).toEqual(live);
      expect(final).toEqual(['bob', 'alice', 'Carl', 'Bob']);
    });

    it('writes final placements to Postgres and stops counting new bets', async () => {
      const t = await createTournament();
      await postBet({ playerId: 'alice', amount: 300 });
      await postBet({ playerId: 'bob', amount: 700 });
      await postBet({ playerId: 'carol', amount: 300 });

      const finalization = app.get(FinalizationService);
      clock.set(AFTER_END);
      expect(await finalization.finalize(t.id)).toBe('finalized');
      expect(await finalization.finalize(t.id)).toBe('already-finalized');

      const results = await prisma.tournamentResult.findMany({
        where: { tournamentId: t.id },
        orderBy: [{ placement: 'asc' }, { playerId: 'asc' }],
      });
      expect(results.map((r) => [r.placement, r.playerId, Number(r.score)])).toEqual([
        [1, 'bob', 700],
        [2, 'alice', 300],
        [2, 'carol', 300],
      ]);

      const late = await postBet({ playerId: 'dave', amount: 10_000 });
      expect(late.json().countedTournamentIds).toEqual([]);

      const board = await leaderboard(t.id);
      expect(board.source).toBe('final');
      expect(board.items.map((i: { playerId: string }) => i.playerId)).toEqual(['bob', 'carol', 'alice']);
    });

    it('does not finalize a tournament that has not ended', async () => {
      const t = await createTournament();
      const finalization = app.get(FinalizationService);
      clock.set(new Date('2099-06-15T00:00:00.000Z'));
      expect(await finalization.finalize(t.id)).toBe('not-ended');
    });
  });

  describe('api docs', () => {
    it('serves Swagger UI and an OpenAPI spec listing every endpoint', async () => {
      const ui = await app.inject({ method: 'GET', url: '/docs' });
      expect(ui.statusCode).toBe(200);
      expect(ui.headers['content-type']).toContain('text/html');

      const spec = (await app.inject({ method: 'GET', url: '/docs-json' })).json();
      expect(Object.keys(spec.paths).sort()).toEqual(
        ['/bet', '/tournaments', '/tournaments/{id}/leaderboard'].sort(),
      );
      expect(spec.components.schemas.CreateBetDto.required).toEqual(
        expect.arrayContaining(['externalBetId', 'playerId', 'amount', 'currency', 'createdAt']),
      );
    });
  });
});
