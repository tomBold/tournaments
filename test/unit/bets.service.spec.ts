import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BetsService } from '../../src/tournaments/bets.service';
import { LeaderboardService } from '../../src/tournaments/leaderboard.service';

const dto = {
  externalBetId: 'bet_1',
  playerId: 'player_42',
  amount: 250,
  currency: 'USD',
  createdAt: '2030-06-04T12:30:00.000Z',
};
const storedBet = {
  id: 'b1',
  player_id: dto.playerId,
  amount: dto.amount,
  currency: dto.currency,
  created_at: new Date(dto.createdAt),
};
const endsAt = new Date('2030-06-30T00:00:00.000Z');

describe('BetsService', () => {
  // Each $queryRaw call inside the transaction returns the next queued result, in SQL order:
  // insert bet -> (select existing bet, if the insert was a no-op) -> matching tournaments -> insert tournament_bets.
  const tx = { $queryRaw: jest.fn() };
  const prisma = { $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const leaderboard = { addBet: jest.fn() };
  let service: BetsService;

  beforeEach(() => {
    tx.$queryRaw.mockReset();
    leaderboard.addBet.mockReset();
    service = new BetsService(
      prisma as unknown as PrismaService,
      leaderboard as unknown as LeaderboardService,
    );
  });

  it('counts a new bet towards every matching tournament and updates each live leaderboard', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([storedBet])
      .mockResolvedValueOnce([
        { id: 't1', ends_at: endsAt },
        { id: 't2', ends_at: endsAt },
      ])
      .mockResolvedValueOnce([{ tournament_id: 't1' }, { tournament_id: 't2' }]);

    const result = await service.ingest(dto);

    expect(result).toEqual({
      betId: 'b1',
      externalBetId: 'bet_1',
      duplicate: false,
      countedTournamentIds: ['t1', 't2'],
    });
    expect(leaderboard.addBet).toHaveBeenCalledTimes(2);
    expect(leaderboard.addBet).toHaveBeenCalledWith('t1', endsAt, 'b1', 'player_42', 250);
    expect(leaderboard.addBet).toHaveBeenCalledWith('t2', endsAt, 'b1', 'player_42', 250);
  });

  it('stores a bet that matches no tournament without counting it', async () => {
    tx.$queryRaw.mockResolvedValueOnce([storedBet]).mockResolvedValueOnce([]);

    const result = await service.ingest(dto);

    expect(result).toMatchObject({ duplicate: false, countedTournamentIds: [] });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  it('reports a re-sent bet as a duplicate but still re-applies it to Redis (idempotent repair)', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([storedBet])
      .mockResolvedValueOnce([{ id: 't1', ends_at: endsAt }])
      .mockResolvedValueOnce([]);

    const result = await service.ingest(dto);

    expect(result).toEqual({
      betId: 'b1',
      externalBetId: 'bet_1',
      duplicate: true,
      countedTournamentIds: [],
    });
    expect(leaderboard.addBet).toHaveBeenCalledWith('t1', endsAt, 'b1', 'player_42', 250);
  });

  it('rejects a re-sent externalBetId with a different payload', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...storedBet, amount: 999 }]);

    await expect(service.ingest(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });

  it('does not touch Redis when the Postgres transaction fails', async () => {
    tx.$queryRaw.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.ingest(dto)).rejects.toThrow('connection lost');
    expect(leaderboard.addBet).not.toHaveBeenCalled();
  });
});
