import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Clock } from '../../src/clock/clock.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  FINALIZATION_QUEUE,
  FinalizationJob,
  finalizeJobId,
} from '../../src/tournaments/finalization.queue';
import { decodeCursor, encodeCursor } from '../../src/tournaments/leaderboard-cursor';
import { LeaderboardService } from '../../src/tournaments/leaderboard.service';
import { tournamentsConfig } from '../../src/tournaments/tournaments.config';
import { TournamentsService } from '../../src/tournaments/tournaments.service';
import { FakeClock } from '../support/fake-clock';
import { testConfig } from '../support/test-config';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('TournamentsService', () => {
  const prisma = {
    tournament: { create: jest.fn(), findUnique: jest.fn() },
    tournamentResult: { count: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const leaderboard = { getPage: jest.fn() };
  const queue = { add: jest.fn() };
  let service: TournamentsService;

  beforeEach(async () => {
    jest.resetAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        TournamentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LeaderboardService, useValue: leaderboard },
        { provide: getQueueToken(FINALIZATION_QUEUE), useValue: queue },
        { provide: tournamentsConfig.KEY, useValue: testConfig },
        { provide: Clock, useValue: new FakeClock(new Date(NOW)) },
      ],
    }).compile();
    service = moduleRef.get(TournamentsService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('create', () => {
    it('rejects endsAt that is not after startsAt', async () => {
      const dto = { name: 'Cup', startsAt: iso(NOW + 60_000), endsAt: iso(NOW + 60_000) };

      await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tournament.create).not.toHaveBeenCalled();
    });

    it('rejects a tournament that has already ended', async () => {
      const dto = { name: 'Cup', startsAt: iso(NOW - 120_000), endsAt: iso(NOW - 60_000) };

      await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tournament.create).not.toHaveBeenCalled();
    });

    it('defaults the currency to USD', async () => {
      prisma.tournament.create.mockResolvedValue({ id: 't1' });

      await service.create({ name: 'Cup', startsAt: iso(NOW), endsAt: iso(NOW + 60_000) });

      expect(prisma.tournament.create).toHaveBeenCalledWith({
        data: { name: 'Cup', startsAt: new Date(NOW), endsAt: new Date(NOW + 60_000), currency: 'USD' },
      });
    });

    it('schedules the finalize job at endsAt + grace with the configured retries', async () => {
      prisma.tournament.create.mockResolvedValue({ id: 't1' });

      await service.create({ name: 'Cup', startsAt: iso(NOW), endsAt: iso(NOW + 60_000) });

      expect(queue.add).toHaveBeenCalledWith(
        FinalizationJob.Finalize,
        { tournamentId: 't1' },
        expect.objectContaining({
          jobId: finalizeJobId('t1'),
          delay: 60_000 + testConfig.finalizeGraceMs,
          attempts: testConfig.finalizeAttempts,
          backoff: { type: 'exponential', delay: testConfig.finalizeBackoffMs },
        }),
      );
    });

    it('still returns the tournament when the job cannot be enqueued', async () => {
      const tournament = { id: 't1' };
      prisma.tournament.create.mockResolvedValue(tournament);
      queue.add.mockRejectedValue(new Error('Redis down'));
      const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(
        service.create({ name: 'Cup', startsAt: iso(NOW), endsAt: iso(NOW + 60_000) }),
      ).resolves.toBe(tournament);
      expect(logError).toHaveBeenCalled();
    });
  });

  describe('getLeaderboard', () => {
    it('throws 404 for an unknown tournament', async () => {
      prisma.tournament.findUnique.mockResolvedValue(null);

      await expect(service.getLeaderboard('t1', 10, 0)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves an open tournament from the live Redis leaderboard', async () => {
      prisma.tournament.findUnique.mockResolvedValue({ id: 't1', status: 'OPEN' });
      const items = [{ placement: 1, playerId: 'alice', score: 500 }];
      leaderboard.getPage.mockResolvedValue({ total: 1, items });

      const page = await service.getLeaderboard('t1', 10, 20);

      expect(leaderboard.getPage).toHaveBeenCalledWith('t1', 10, 20);
      expect(page).toEqual({
        tournamentId: 't1',
        status: 'OPEN',
        source: 'live',
        total: 1,
        limit: 10,
        offset: 20,
        items,
        nextCursor: null,
      });
    });

    it('keeps serving a CLOSING tournament live until its results are written', async () => {
      prisma.tournament.findUnique.mockResolvedValue({ id: 't1', status: 'CLOSING' });
      leaderboard.getPage.mockResolvedValue({ total: 0, items: [] });

      await expect(service.getLeaderboard('t1', 10, 0)).resolves.toMatchObject({ source: 'live' });
    });

    it('serves a finalized tournament from Postgres results', async () => {
      prisma.tournament.findUnique.mockResolvedValue({ id: 't1', status: 'FINALIZED' });
      prisma.tournamentResult.count.mockResolvedValue(2);
      prisma.$queryRaw.mockResolvedValue([
        { placement: 1, player_id: 'bob', score: 700n },
        { placement: 2, player_id: 'alice', score: 300n },
      ]);

      const page = await service.getLeaderboard('t1', 10, 0);

      expect(leaderboard.getPage).not.toHaveBeenCalled();
      expect(page).toMatchObject({ source: 'final', status: 'FINALIZED', total: 2, nextCursor: null });
      expect(page.items).toEqual([
        { placement: 1, playerId: 'bob', score: 700 },
        { placement: 2, playerId: 'alice', score: 300 },
      ]);
    });

    describe('cursors', () => {
      it('hands out an offset cursor on a live page that has more rows', async () => {
        prisma.tournament.findUnique.mockResolvedValue({ id: 't1', status: 'OPEN' });
        leaderboard.getPage.mockResolvedValue({
          total: 5,
          items: [{ placement: 1, playerId: 'alice', score: 500 }],
        });

        const first = await service.getLeaderboard('t1', 1, 0);
        expect(decodeCursor(first.nextCursor!)).toEqual({ offset: 1 });

        await service.getLeaderboard('t1', 1, 0, first.nextCursor!);
        expect(leaderboard.getPage).toHaveBeenLastCalledWith('t1', 1, 1);
      });

      it('continues a final page by keyset after the last row, not by OFFSET', async () => {
        prisma.tournament.findUnique.mockResolvedValue({ id: 't1', status: 'FINALIZED' });
        prisma.tournamentResult.count.mockResolvedValue(3);
        prisma.$queryRaw.mockResolvedValue([{ placement: 2, player_id: 'carol', score: 300n }]);
        const cursor = encodeCursor({ offset: 1, after: { placement: 1, playerId: 'bob' } });

        const page = await service.getLeaderboard('t1', 1, 0, cursor);

        expect(page.offset).toBe(1);
        // Tagged template call: (strings, tournamentId, keyset fragment, limit, offset).
        const [, , keyset, , offset] = prisma.$queryRaw.mock.calls[0] as [unknown, unknown, Prisma.Sql, unknown, unknown];
        expect(keyset.values).toEqual([1, 1, 'bob']);
        expect(offset).toBe(0);
        expect(decodeCursor(page.nextCursor!)).toEqual({
          offset: 2,
          after: { placement: 2, playerId: 'carol' },
        });
      });

      it('rejects a malformed cursor with 400', async () => {
        await expect(service.getLeaderboard('t1', 10, 0, 'not-a-cursor')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.tournament.findUnique).not.toHaveBeenCalled();
      });
    });
  });
});
