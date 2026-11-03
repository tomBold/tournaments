import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FinalizationService } from '../../src/tournaments/finalization.service';
import { LeaderboardService } from '../../src/tournaments/leaderboard.service';
import { FakeClock } from '../support/fake-clock';
import { testConfig } from '../support/test-config';

const NOW = new Date('2030-07-01T00:00:00.000Z');
const ENDED = new Date('2030-06-30T00:00:00.000Z');

describe('FinalizationService', () => {
  // $executeRaw: the exclusive tournament lock (close step), then the placements insert (results step).
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    tournament: { update: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown, _options?: unknown) => fn(tx)),
    tournament: { findMany: jest.fn() },
  };
  const leaderboard = { clear: jest.fn() };
  let service: FinalizationService;

  beforeEach(() => {
    jest.clearAllMocks();
    leaderboard.clear.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    service = new FinalizationService(
      prisma as unknown as PrismaService,
      leaderboard as unknown as LeaderboardService,
      testConfig,
      new FakeClock(NOW),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

  describe('finalize', () => {
    it('closes the tournament, then writes placements in a separate transaction', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'OPEN', ends_at: ENDED }]);

      await expect(service.finalize('t1')).resolves.toBe('finalized');

      expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain('pg_advisory_xact_lock(');
      expect(tx.tournament.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'CLOSING' } });
      expect(sqlOf(tx.$executeRaw.mock.calls[1])).toContain('INSERT INTO tournament_results');
      expect(tx.tournament.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', status: 'CLOSING' },
        data: { status: 'FINALIZED', finalizedAt: NOW },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      // Only the aggregate gets the long timeout; the close step must stay short for waiting bets.
      expect(prisma.$transaction.mock.calls[0][1]).toBeUndefined();
      expect(prisma.$transaction.mock.calls[1][1]).toEqual({ timeout: testConfig.finalizeTimeoutMs });
      expect(leaderboard.clear).toHaveBeenCalledWith('t1');
    });

    it('resumes a tournament left CLOSING by an interrupted run', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'CLOSING', ends_at: ENDED }]);

      await expect(service.finalize('t1')).resolves.toBe('finalized');

      expect(tx.tournament.update).not.toHaveBeenCalled();
      expect(tx.tournament.updateMany).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['not-found', []],
      ['already-finalized', [{ status: 'FINALIZED', ends_at: ENDED }]],
      ['not-ended', [{ status: 'OPEN', ends_at: new Date(NOW.getTime() + 1) }]],
    ])('returns %s without writing anything', async (outcome, rows) => {
      tx.$queryRaw.mockResolvedValue(rows);

      await expect(service.finalize('t1')).resolves.toBe(outcome);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.tournament.update).not.toHaveBeenCalled();
      expect(tx.tournament.updateMany).not.toHaveBeenCalled();
    });

    it('clears the live keys again on a retry, in case the first attempt could not', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'FINALIZED', ends_at: ENDED }]);

      await service.finalize('t1');

      expect(leaderboard.clear).toHaveBeenCalledWith('t1');
    });

    it.each([
      ['not-found', []],
      ['not-ended', [{ status: 'OPEN', ends_at: new Date(NOW.getTime() + 1) }]],
    ])('keeps the live keys when the outcome is %s', async (_outcome, rows) => {
      tx.$queryRaw.mockResolvedValue(rows);

      await service.finalize('t1');

      expect(leaderboard.clear).not.toHaveBeenCalled();
    });

    it('still reports success when clearing Redis fails', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'OPEN', ends_at: ENDED }]);
      leaderboard.clear.mockRejectedValue(new Error('Redis down'));

      await expect(service.finalize('t1')).resolves.toBe('finalized');
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('Redis down'));
    });
  });

  describe('findOverdue', () => {
    it('queries unfinalized tournaments past endsAt + grace, oldest first, in configured batches', async () => {
      prisma.tournament.findMany.mockResolvedValue([{ id: 't1' }]);

      await expect(service.findOverdue()).resolves.toEqual(['t1']);
      expect(prisma.tournament.findMany).toHaveBeenCalledWith({
        where: {
          status: { in: ['OPEN', 'CLOSING'] },
          endsAt: { lt: new Date(NOW.getTime() - testConfig.finalizeGraceMs) },
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: testConfig.sweepBatchSize,
      });
    });
  });
});
