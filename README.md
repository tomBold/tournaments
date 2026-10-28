# Tournaments Service

A NestJS (Fastify) service that creates tournaments, ingests bet events, serves a **live leaderboard from Redis**,
and uses a **BullMQ** delayed job to write **final placements to Postgres** after each tournament ends.

**Stack:** NestJS 11 · Fastify · Postgres 16 + Prisma 6 · Redis 7 · BullMQ · Jest · Docker Compose

---

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Data model](#data-model)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Configuration](#configuration)
- [Assumptions](#assumptions)
- [Tradeoffs](#tradeoffs)

---

## Quick start

**Requirement:** Docker. One command builds and starts everything:

```bash
docker compose up --build -d --wait     # or: npm run up
```

This starts **Postgres → Redis → migrations → API + worker**, each waiting for what it depends on.
The API listens on **http://localhost:3000**, and the interactive API docs (Swagger UI) are at
**http://localhost:3000/docs**. Every endpoint there has a pre-filled valid example you can send with "Try it out".

| Command | What it does |
| --- | --- |
| `npm run up` | Build and start the full stack |
| `npm run logs` | Follow API and worker logs |
| `npm run down` | Stop everything |
| `npm run verify` | Run everything that proves the project works: type check, unit tests, start Postgres + Redis, e2e tests |

### Local development (Node 20+)

```bash
npm install
cp .env.example .env                          # PowerShell: Copy-Item .env.example .env
npm run infra                                 # Postgres + Redis only
npx prisma migrate deploy
npm run start:dev                             # API, watch mode
npm run start:worker:dev                      # worker, watch mode (second terminal)
```

> If the full Docker stack is running, free port 3000 first with `docker compose stop api worker`.

---

## API

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| `POST` | `/tournaments` | `{ name, startsAt, endsAt, currency? }` | `201` and the tournament |
| `POST` | `/bet` | `{ externalBetId, playerId, amount, currency, createdAt }` | `200`, including for duplicates |
| `GET` | `/tournaments/:id/leaderboard` | `?limit=50&offset=0` (limit 1–100) | `200` and a page of placements |

The OpenAPI spec is generated from the same DTO classes that validate requests, so the docs can't drift from the
validation rules. UI: `/docs`, raw JSON: `/docs-json`.

Errors: `400` for invalid input, `404` for an unknown tournament, and `409` when an `externalBetId` is re-sent
with a different payload.

### Example

```bash
# 1. Create a tournament
curl -X POST localhost:3000/tournaments -H 'content-type: application/json' \
  -d '{"name":"June Cup","startsAt":"2027-06-01T00:00:00Z","endsAt":"2027-06-30T23:59:59Z"}'

# 2. Send a bet (sending it again returns "duplicate": true and doesn't change the score)
curl -X POST localhost:3000/bet -H 'content-type: application/json' \
  -d '{"externalBetId":"bet_123456","playerId":"player_42","amount":250,"currency":"USD","createdAt":"2027-06-04T12:30:00.000Z"}'
```
```json
{ "betId": "…", "externalBetId": "bet_123456", "duplicate": false, "countedTournamentIds": ["…"] }
```

```bash
# 3. Read the leaderboard
curl 'localhost:3000/tournaments/<id>/leaderboard?limit=10&offset=0'
```
```json
{
  "tournamentId": "…", "status": "OPEN", "source": "live",
  "total": 3, "limit": 10, "offset": 0,
  "items": [
    { "placement": 1, "playerId": "carol", "score": 550 },
    { "placement": 1, "playerId": "alice", "score": 550 },
    { "placement": 3, "playerId": "bob",   "score": 500 }
  ]
}
```

Scores are in cents, like `amount`. `source` is `live` (Redis) while the tournament runs and `final` (Postgres)
after it has been finalized.

---

## Architecture

Two Node processes are built from the same codebase: the **API** handles HTTP, and the **worker** runs BullMQ
jobs. This mirrors a typical separate workers app. They share Postgres (durable data) and Redis (the live
leaderboards and the BullMQ queue).

```mermaid
flowchart LR
    Client(["Client / game backend"])

    subgraph API["API process - NestJS + Fastify"]
        TC["TournamentsController<br/>POST /tournaments<br/>GET /tournaments/:id/leaderboard"]
        BC["BetsController<br/>POST /bet"]
        TS["TournamentsService"]
        BS["BetsService"]
        LS["LeaderboardService"]
    end

    subgraph Worker["Worker process - NestJS app context"]
        FP["FinalizationProcessor<br/>finalize + sweep jobs"]
        FS["FinalizationService"]
    end

    subgraph Redis["Redis"]
        ZSET[("Sorted set per tournament<br/>live leaderboard")]
        SEEN[("Set per tournament<br/>bets already counted")]
        Q[("BullMQ queue<br/>tournament-finalization")]
    end

    subgraph PG["Postgres (via Prisma)"]
        T[("tournaments")]
        B[("bets")]
        TB[("tournament_bets")]
        TR[("tournament_results")]
    end

    Client --> TC & BC
    TC --> TS
    BC --> BS
    TS -- "create" --> T
    TS -- "schedule delayed job" --> Q
    TS -- "live page" --> LS
    TS -- "final page" --> TR
    BS -- "insert bet + count per tournament" --> B & TB
    BS -- "add score (Lua)" --> LS
    LS --> ZSET & SEEN
    Q -- "after endsAt" --> FP
    FP --> FS
    FS -- "SUM + RANK" --> TB
    FS -- "write placements" --> TR
    FS -- "mark FINALIZED" --> T
```

### What lives where

| Store | Holds | Why |
| --- | --- | --- |
| **Postgres** | Tournaments, every bet, which bets counted in which tournament, final results | Source of truth: durable, transactional, enforces "once per tournament" with a primary key |
| **Redis: sorted sets** | Live score per player per tournament | Fast ranking (`ZINCRBY`, `ZREVRANGE`) for the live leaderboard |
| **Redis: BullMQ** | Delayed finalize jobs and a periodic sweep | Runs the snapshot after `endsAt`, with retries |

### Dependency injection

Every class receives what it uses through its constructor, and nothing reaches for globals. That is what lets each
dependency be swapped for a mock or fake in tests.

| Dependency | Injection token | Provided by | Replaced in tests with |
| --- | --- | --- | --- |
| Postgres | `PrismaService` (URL from `ConfigService`) | `PrismaModule` (global) | Plain object of `jest.fn()` |
| Redis | `REDIS` symbol | `RedisModule` (global) | In-memory fake sorted set |
| BullMQ queue | `getQueueToken(FINALIZATION_QUEUE)` | `BullModule.registerQueue` | `{ add: jest.fn() }` |
| Settings | `tournamentsConfig.KEY` | `ConfigModule.forFeature` | `test/support/test-config.ts` |
| Current time | `Clock` (abstract class) | `ClockModule` → `SystemClock` | `FakeClock` (`overrideProvider` in e2e) |

The clock matters most: tournament windows, job delays, finalization and key expiry all depend on "now". With an
injected `Clock`, tests set the time explicitly instead of patching `Date` or waiting.

---

## How it works

### 1. Bet ingestion: `POST /bet`

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as BetsService
    participant PG as Postgres
    participant R as Redis

    C->>API: POST /bet
    API->>PG: BEGIN
    API->>PG: INSERT bet ON CONFLICT (external_bet_id) DO NOTHING
    alt bet already exists
        API->>PG: SELECT existing bet
        Note over API: Different payload → 409 Conflict<br/>Same payload → continue (idempotent)
    end
    API->>PG: SELECT OPEN tournaments where<br/>startsAt ≤ createdAt ≤ endsAt (same currency)<br/>FOR SHARE
    API->>PG: INSERT tournament_bets ON CONFLICT DO NOTHING<br/>RETURNING newly counted tournaments
    API->>PG: COMMIT
    loop each matching tournament
        API->>R: Lua: if SADD(seen, betId) then ZINCRBY(board, amount, player)
    end
    API-->>C: 200 { duplicate, countedTournamentIds }
```

- **Once per tournament** is guaranteed in Postgres by the `tournament_bets` primary key `(tournament_id, bet_id)`.
  Ten identical requests at the same moment still count once (this is tested).
- **Redis is idempotent too.** The Lua script only adds to the score the first time it sees a bet id for a
  tournament. If Redis fails after the Postgres commit, the client retries and Redis catches up without double counting.
- **A bet can count in several tournaments.** Every open tournament whose window contains `createdAt` gets it.

### 2. Live leaderboard: `GET /tournaments/:id/leaderboard`

- **Before finalization**, the page is read from the Redis sorted set (`ZREVRANGE` + `ZCARD`).
- **After finalization**, the page is read from `tournament_results` in Postgres.
- **Ties share a placement** (competition ranking): scores 500, 400, 400, 50 → placements 1, 2, 2, 4.
  Placements are absolute, so page 2 doesn't restart at 1.

### 3. Tournament lifecycle and finalization

```mermaid
stateDiagram-v2
    direction LR
    [*] --> OPEN: POST /tournaments<br/>(delayed BullMQ job scheduled<br/>for endsAt + grace)
    OPEN --> OPEN: bets in window<br/>update Redis + Postgres
    OPEN --> FINALIZED: finalize job runs<br/>(or the 60 s sweep)
    FINALIZED --> [*]: leaderboard served<br/>from tournament_results
```

When the job runs, the worker does all of this in one transaction:

1. **Locks the tournament row** (`FOR UPDATE`). Bet ingestion holds `FOR SHARE` on the same row, so the
   worker waits for in-flight bets and blocks new ones. No bet can slip in after results are computed.
2. **Computes placements** with `SUM(amount)` per player and `RANK() OVER (ORDER BY score DESC)`, and inserts
   them into `tournament_results`.
3. **Marks the tournament `FINALIZED`.** Later bets are still stored but no longer count towards it.

The job is idempotent (running it twice is a no-op) and retries with exponential backoff. A **sweep job every
60 s** finalizes any overdue tournament whose job was never enqueued, for example because Redis was down when the
tournament was created.

---

## Data model

```mermaid
erDiagram
    tournaments ||--o{ tournament_bets : "counts"
    bets ||--o{ tournament_bets : "counted in"
    tournaments ||--o{ tournament_results : "final placements"

    tournaments {
        uuid id PK
        string name
        string currency "default USD"
        timestamptz starts_at
        timestamptz ends_at
        enum status "OPEN | FINALIZED"
        timestamptz finalized_at
    }
    bets {
        uuid id PK
        string external_bet_id UK
        string player_id
        int amount "cents"
        string currency
        timestamptz created_at
    }
    tournament_bets {
        uuid tournament_id PK, FK
        uuid bet_id PK, FK
        string player_id
        int amount
    }
    tournament_results {
        uuid tournament_id PK, FK
        string player_id PK
        bigint score
        int placement
    }
```

Schema: [`prisma/schema.prisma`](prisma/schema.prisma). Migration: [`prisma/migrations/`](prisma/migrations).

---

## Project structure

```
src/
├── main.ts                     API entry point (Fastify)
├── worker.ts                   Worker entry point (no HTTP)
├── app.module.ts               API module
├── worker.module.ts            Worker module (adds FinalizationProcessor)
├── core.module.ts              Config, Clock, Prisma, Redis, BullMQ connection (shared)
├── configure-app.ts            Validation pipe, shutdown hooks, Swagger (shared by main.ts and e2e tests)
├── clock/                      Injectable Clock (SystemClock in the app, FakeClock in tests)
├── prisma/                     PrismaService
├── redis/                      ioredis client provider + BullMQ connection options
└── tournaments/
    ├── tournaments.module.ts       The Tournaments module
    ├── tournaments.config.ts       Typed, validated settings (env vars with defaults)
    ├── tournaments.controller.ts   POST /tournaments, GET leaderboard
    ├── tournaments.service.ts      Create tournament + schedule job, read leaderboard
    ├── bets.controller.ts          POST /bet
    ├── bets.service.ts             Bet ingestion (Postgres transaction, then Redis)
    ├── leaderboard.service.ts      Redis sorted sets + Lua script
    ├── finalization.queue.ts       Queue name, job names and ids
    ├── finalization.service.ts     Writes final placements
    ├── finalization.processor.ts   BullMQ processor (finalize + sweep), worker only
    └── dto/                        Request DTOs and their validation decorators
test/
├── unit/                       One spec per source file, dependencies mocked (no Docker)
├── e2e/                        Real app against Postgres + Redis, with its env and DB setup
└── support/                    Shared test helpers: FakeClock, test config
.github/workflows/ci.yml        CI: checks + unit, e2e, Docker smoke test, test reports
```

Files are named `<area>.<role>.ts`: one area per concern (`tournaments`, `bets`, `leaderboard`, `finalization`)
and the standard Nest role suffixes (`.module`, `.controller`, `.service`, `.processor`, `.dto`, `.decorator`).

---

## Testing

| Command | What runs | Needs Docker |
| --- | --- | --- |
| `npm run test:unit` | 37 unit tests with mocked Prisma, Redis, BullMQ and config (a few seconds) | No |
| `npm run test:e2e` | 23 end-to-end tests against real Postgres and Redis | Yes |
| `npm test` | Both (start Postgres + Redis first with `npm run infra`) | Yes |
| `npm run verify` | Type check, unit tests, `npm run infra`, e2e tests; stops at the first failure | Yes |

```bash
npm run verify
```

**Unit tests** (`test/unit/`) build each class through Nest's `Test.createTestingModule` (or its constructor) with
mocks in place of its dependencies. They cover the logic in isolation: job scheduling and retry options, duplicate
detection, the 409 rule, live and final leaderboard sources, tie placements across page boundaries, Redis key
expiry, every finalization outcome, the worker's job routing and sweep, and config validation.

**End-to-end tests** boot the real Nest/Fastify app against a separate **`tournaments_test`** database (created
and migrated automatically) and **Redis DB 15**, so dev data is never touched. The real `Clock` is swapped for a
`FakeClock` with `overrideProvider`, so "after the tournament ended" is a single `clock.set(...)`. They cover:

- **Bet ingestion:** counting, inclusive window bounds, other currencies, several tournaments, validation, timezones
- **Duplicates:** re-sent bets, 10 concurrent identical bets, repair after a lost Redis write, `409` on a payload mismatch
- **Leaderboard:** ordering, shared placements on ties, pagination, query validation, `404`
- **Finalization:** delayed BullMQ job scheduled, final placements, late bets ignored, idempotency, consistent tie
  order, no early finalization
- **API docs:** Swagger UI is served and the spec lists every endpoint

### CI (GitHub Actions)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main`, every pull request, and on
demand. It has three parallel jobs:

| Job | What it does |
| --- | --- |
| Type check, build, unit tests | `npm ci`, `typecheck`, `build`, unit tests |
| End-to-end tests | Same e2e suite against Postgres 16 and Redis 7 service containers |
| Docker stack smoke test | `docker compose up --build`, then checks the API serves `/docs-json` and the worker started |

**Test reports.** Jest writes JUnit XML (`jest-junit`), and
[dorny/test-reporter](https://github.com/dorny/test-reporter) publishes it in two places: as a "Unit test report" and
an "End-to-end test report" check (failed tests are annotated on the code), and in the run's summary page. The XML
files are also uploaded as artifacts. Publishing checks needs `checks: write`, which GitHub doesn't grant to pull
requests from forks, so on fork PRs only the tests themselves run.

---

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/tournaments` | Postgres connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis for leaderboards and BullMQ |
| `PORT` | `3000` | API port |
| `FINALIZE_GRACE_MS` | `5000` | Delay after `endsAt` before finalizing, so in-flight bets can land |
| `FINALIZE_ATTEMPTS` | `10` | Retries of the finalize job |
| `FINALIZE_BACKOFF_MS` | `5000` | Base delay of the exponential backoff between retries |
| `FINALIZE_TIMEOUT_MS` | `60000` | Upper bound for the finalize transaction |
| `FINALIZE_SWEEP_EVERY_MS` | `60000` | How often the worker finalizes overdue tournaments whose job was lost |
| `FINALIZE_SWEEP_BATCH_SIZE` | `100` | Overdue tournaments handled per sweep, oldest first |
| `LEADERBOARD_TTL_AFTER_END_SECONDS` | `604800` | How long live Redis keys are kept after `endsAt` (7 days) |

The tournament settings live in one typed object, `src/tournaments/tournaments.config.ts` (`registerAs`), injected
with `@Inject(tournamentsConfig.KEY)`. Invalid values (for example `FINALIZE_ATTEMPTS=0`) stop the app at startup,
and tests replace the whole object with `{ provide: tournamentsConfig.KEY, useValue: ... }`.

---

## Assumptions

- **`createdAt` decides whether a bet counts**, with both window bounds inclusive. Dates must include a timezone
  (`Z` or `+02:00`). Without one, the result would depend on the server's timezone, so they're rejected with `400`.
- **A tournament must end in the future** when created. An already-ended one would be finalized immediately with
  an empty leaderboard.
- **One currency per tournament** (default `USD`), and only bets in that currency count. Cents in different
  currencies can't be summed without FX conversion.
- **`amount`** is a positive integer in cents. Totals are `BIGINT` in Postgres, and Redis scores are exact up to 2^53 cents.
- **`externalBetId` is globally unique.** Re-sending it with a different payload is a client bug and gets `409`.
- **Duplicates return `200` with `duplicate: true`.** If a re-sent bet now matches a tournament created after it
  first arrived, it counts there (still at most once per tournament).
- **Bets arriving after finalization** (beyond `FINALIZE_GRACE_MS`) don't change the final results.
- **Ties share a placement.** Within a tie, the order is player id descending by bytes (Redis's natural order). The
  final results query uses `COLLATE "C"` to match, so the order doesn't change after finalization.
- **Out of scope:** auth, rate limiting, and endpoints to list or update tournaments.

## Tradeoffs

- **Final placements are computed from Postgres, not copied from Redis.** The sums are the same, but Postgres is
  durable and locked against late bets, while Redis could be evicted or behind after a partial failure. The cost
  is one aggregate query per tournament at finalization, which the `(tournament_id, player_id)` index covers.
- **One Postgres write per bet per tournament.** This gives exact idempotency and an audit trail, at the cost of
  write volume. At very high throughput you'd batch inserts or put a queue in front of ingestion.
- **Redis is not rebuilt automatically after a full wipe.** Retries repair individual bets, but if Redis lost
  everything mid-tournament, the live board would be short until finalization (which is still correct).
  Rebuilding from `tournament_bets` would be a small addition.
- **The row lock only affects the tournament being finalized.** Bets for other tournaments, and concurrent bets
  for the same tournament, don't block each other.
- **Redis keys expire** 7 days after `endsAt` (or the latest write, if later). After that, Postgres is the only source.
- **No RabbitMQ.** The task asks for BullMQ, which runs on the same Redis, so there's no extra broker to operate.
- **Pinned to NestJS 11 and Prisma 6** (stable, well-known APIs) rather than the newest major versions.
- **`@fastify/static` is pinned to 10.1.3.** Swagger UI needs it on Fastify. Later 10.1.x releases depend on an
  ESM-only `content-disposition`, which Jest can't load on Node below 24.9. 10.1.3 still satisfies the NestJS
  peer range.
