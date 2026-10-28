# Tournaments Task: RealPlay Backend Engineer

We run a NestJS/Fastify backend with Postgres (Prisma ORM), Redis, and a separate workers app.

**Goal:** a small Tournaments NestJS module.

Build a small NestJS service that creates tournaments, ingests bet events, exposes a live leaderboard, and writes
final results after the tournament ends.

## Required endpoints

- `POST /bet`: processes bets from the client and writes them to the bets table
- `POST /tournaments`: creates a tournament with `name`, `startsAt`, and `endsAt`
- `GET /tournaments/:id/leaderboard?limit&offset`: returns paginated player placements on the leaderboard, sorted by score DESC

## Bet payload

```jsonc
{
  "externalBetId": "bet_123456",          // string
  "playerId": "player_42",                // string
  "amount": 250,                          // int
  "currency": "USD",                      // string
  "createdAt": "2026-06-04T12:30:00.000Z" // string (date)
}
```

## Rules

- `amount` is in cents, so `250` means $2.50.
- A bet counts only when `startsAt <= createdAt <= endsAt`.
- A bet can count towards more than one active tournament.
- Each `externalBetId` must be counted only once per tournament. Duplicate events should return a success/idempotent
  response without increasing the score twice.
- Tournament score is the running sum of accepted bet amounts per player.
- Use Redis for live ranking.
- Use BullMQ to schedule a snapshot job that writes final placements to Postgres after `endsAt`.

## Deliverables

- A runnable service with clear setup instructions.
- Prisma schema and migration(s).
- A short README explaining assumptions and tradeoffs.
- (BONUS) Minimal tests covering bet ingestion, duplicate bet handling, and leaderboard ordering.
