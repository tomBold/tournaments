import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FinalizationService } from '../../src/tournaments/finalization.service';
import { FakeClock } from '../support/fake-clock';
import { testConfig } from '../support/test-config';

const NOW = new Date('2030-07-01T00:00:00.000Z');
const ENDED = new Date('2030-06-30T00:00:00.000Z');

describe('FinalizationService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    tournament: { update: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown, _options?: unknown) => fn(tx)),
    tournament: { findMany: jest.fn() },
  };
  let service: FinalizationService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    service = new FinalizationService(
      prisma as unknown as PrismaService,
      testConfig,
      new FakeClock(NOW),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('finalize', () => {
    it('writes placements and marks the tournament FINALIZED within the configured timeout', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'OPEN', ends_at: ENDED }]);

      await expect(service.finalize('t1')).resolves.toBe('finalized');

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.tournament.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'FINALIZED', finalizedAt: NOW },
      });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: testConfig.finalizeTimeoutMs,
      });
    });

    it.each([
      ['not-found', []],
      ['already-finalized', [{ status: 'FINALIZED', ends_at: ENDED }]],
      ['not-ended', [{ status: 'OPEN', ends_at: new Date(NOW.getTime() + 1) }]],
    ])('returns %s without writing anything', async (outcome, rows) => {
      tx.$queryRaw.mockResolvedValue(rows);

      await expect(service.finalize('t1')).resolves.toBe(outcome);

      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.tournament.update).not.toHaveBeenCalled();
    });
  });

  describe('findOverdue', () => {
    it('queries open tournaments past endsAt + grace, oldest first, in configured batches', async () => {
      prisma.tournament.findMany.mockResolvedValue([{ id: 't1' }]);

      await expect(service.findOverdue()).resolves.toEqual(['t1']);
      expect(prisma.tournament.findMany).toHaveBeenCalledWith({
        where: {
          status: 'OPEN',
          endsAt: { lt: new Date(NOW.getTime() - testConfig.finalizeGraceMs) },
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: testConfig.sweepBatchSize,
      });
    });
  });
});
