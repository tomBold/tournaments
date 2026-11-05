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
- [Architecture and End-to-End Flow](#architecture-and-end-to-end-flow)

---

## Quick start

**Requirement:** Docker. One command builds and starts everything:

```bash
docker compose up --build -d --wait     # or: npm run up
```

This starts **Postgres → Redis → migrations → API + worker**, each waiting for what it depends on.
The API listens on **<http://localhost:3000>**, and the interactive API docs (Swagger UI) are at
**<http://localhost:3000/docs>**. Every endpoint there has a pre-filled valid example you can send with "Try it out".

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
tournament was created. A failure on one tournament is logged and doesn't stop the sweep from handling the rest;
that tournament stays `OPEN` and is retried by the next sweep.

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

```text
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
| `npm run test:unit` | 39 unit tests with mocked Prisma, Redis, BullMQ and config (a few seconds) | No |
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
  for the same tournament, don't block each other. A bet for a tournament *while it is being finalized* waits for
  the lock, so the bet transaction's timeout is `FINALIZE_TIMEOUT_MS` plus 5 s of headroom rather than Prisma's
  5 s default; the bet then completes normally and is simply not counted towards the now-finalized tournament.
- **Redis keys expire** 7 days after `endsAt` (or the latest write, if later). After that, Postgres is the only source.
- **No RabbitMQ.** The task asks for BullMQ, which runs on the same Redis, so there's no extra broker to operate.
- **Pinned to NestJS 11 and Prisma 6** (stable, well-known APIs) rather than the newest major versions.
- **`@fastify/static` is pinned to 10.1.3.** Swagger UI needs it on Fastify. Later 10.1.x releases depend on an
  ESM-only `content-disposition`, which Jest can't load on Node below 24.9. 10.1.3 still satisfies the NestJS
  peer range.

---

## Architecture and End-to-End Flow

This section walks through one tournament from creation to final results, based on the code on `main`. It is
written for explaining the project in an interview. Everything up to [Later improvements](#later-improvements)
describes the **original submission**. Line links point at the current `main` branch.

### Glossary

| Term | Meaning in this project |
| --- | --- |
| **API process** | [`src/main.ts`](src/main.ts): a NestJS app on Fastify that serves HTTP. |
| **Worker process** | [`src/worker.ts`](src/worker.ts): the same codebase started without HTTP. It only runs background jobs. |
| **Postgres** | The relational database and **source of truth** (the copy that wins if the stores disagree). Accessed through Prisma, a TypeScript ORM. |
| **Transaction** | A group of SQL statements that commit together or not at all (`BEGIN` … `COMMIT`). |
| **Row lock** | `FOR SHARE` lets many transactions read a row while preventing others from changing it. `FOR UPDATE` is exclusive: it waits until no one else holds a lock on the row. |
| **Redis** | An in-memory key-value store. Here it holds the live leaderboards and the BullMQ queue. |
| **Sorted set** | A Redis type that stores unique members, each with a numeric score, kept ordered by score. |
| **BullMQ** | A Node.js job-queue library that stores its jobs **in Redis**. |
| **Idempotent** | Doing it twice has the same effect as doing it once. |

### End-to-end sequence

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as API process
    participant PG as Postgres
    participant R as Redis leaderboard keys
    participant Q as BullMQ queue (in Redis)
    participant W as Worker process

    Note over C,W: 1. Create a tournament
    C->>API: POST /tournaments {name, startsAt, endsAt, currency?}
    API->>API: Validate body, endsAt after startsAt, endsAt in the future
    API->>PG: INSERT tournaments (status OPEN)
    API->>Q: add "finalize" job, jobId "finalize_" + id<br/>delay = endsAt - now + FINALIZE_GRACE_MS
    Note right of Q: If add fails, the error is only logged.<br/>The sweep (step 5) covers it.
    API-->>C: 201 tournament

    Note over C,W: 2. Ingest a bet
    C->>API: POST /bet {externalBetId, playerId, amount, currency, createdAt}
    API->>API: ValidationPipe checks the body (400 if invalid)
    API->>PG: BEGIN
    API->>PG: INSERT bets ON CONFLICT (external_bet_id) DO NOTHING
    alt externalBetId already stored
        API->>PG: SELECT the existing bet
        Note right of API: Different payload: 409 and ROLLBACK<br/>Same payload: continue
    end
    API->>PG: SELECT OPEN tournaments, same currency,<br/>startsAt ≤ createdAt ≤ endsAt, FOR SHARE
    API->>PG: INSERT tournament_bets ON CONFLICT DO NOTHING<br/>RETURNING newly counted tournament ids
    API->>PG: COMMIT
    loop each matching tournament, after the commit
        API->>R: Lua script: SADD bet id to seen set<br/>if new: ZINCRBY score, EXPIREAT both keys
    end
    API-->>C: 200 {betId, duplicate, countedTournamentIds}

    Note over C,W: 3. Read the leaderboard
    C->>API: GET /tournaments/{id}/leaderboard?limit&offset
    API->>PG: SELECT tournament (404 if missing)
    alt status OPEN
        API->>R: MULTI ZCARD + ZREVRANGE WITHSCORES, then ZCOUNT
        API-->>C: 200 source "live"
    else status FINALIZED
        API->>PG: COUNT and SELECT tournament_results ORDER BY placement
        API-->>C: 200 source "final"
    end

    Note over C,W: 4. Finalize (delayed job becomes due at about endsAt + grace)
    Q->>W: deliver "finalize" job
    W->>PG: BEGIN, SELECT tournament FOR UPDATE<br/>(waits for in-flight bet transactions)
    alt not found or already FINALIZED
        W->>PG: COMMIT, nothing to do
    else endsAt still in the future
        W->>PG: COMMIT, nothing written
        W-->>Q: throw, BullMQ retries with exponential backoff
    else ended and still OPEN
        W->>PG: INSERT tournament_results (SUM + RANK)
        W->>PG: UPDATE tournaments SET status FINALIZED, finalized_at
        W->>PG: COMMIT
    end

    Note over C,W: 5. Recovery sweep (repeats every FINALIZE_SWEEP_EVERY_MS, default 60 s)
    Q->>W: deliver "sweep" job from the job scheduler
    W->>PG: SELECT OPEN tournaments with endsAt before now - grace<br/>oldest first, up to FINALIZE_SWEEP_BATCH_SIZE
    loop each overdue tournament
        W->>PG: same finalize transaction as step 4<br/>(a failure is logged, the loop continues)
    end
```

### Step by step

#### 1. `POST /tournaments` — create and schedule

[`TournamentsController.create`](src/tournaments/tournaments.controller.ts#L19-L39) passes the validated body
to [`TournamentsService.create`](src/tournaments/tournaments.service.ts#L40-L76):

1. **Validation.** The global `ValidationPipe` ([`configure-app.ts`](src/configure-app.ts#L5)) checks
   [`CreateTournamentDto`](src/tournaments/dto/create-tournament.dto.ts). The service then rejects
   `endsAt <= startsAt` and an `endsAt` that is already in the past
   ([lines 44–50](src/tournaments/tournaments.service.ts#L44-L50)).
2. **Persist.** One Prisma `create` inserts the row with status `OPEN` and currency `USD` by default
   ([lines 52–54](src/tournaments/tournaments.service.ts#L52-L54)). This single insert is not wrapped in a
   larger transaction.
3. **Schedule.** `finalizationQueue.add('finalize', …)` creates a delayed BullMQ job
   ([lines 56–68](src/tournaments/tournaments.service.ts#L56-L68)) with:
   - `jobId: finalize_<tournamentId>`, a fixed id so the same tournament doesn't get two pending jobs;
   - `delay: endsAt − now + FINALIZE_GRACE_MS` (5 s by default), so bets made in the last moments can still land;
   - `attempts: 10` and exponential `backoff` starting at 5 s;
   - `removeOnComplete: true` and `removeOnFail: false`, so failed jobs stay in Redis where they can be inspected.
4. **If scheduling fails**, the error is logged and the tournament is still returned
   ([lines 69–73](src/tournaments/tournaments.service.ts#L69-L73)). Returning an error would make the client
   retry and create a duplicate tournament. The worker's sweep finalizes it later.

#### 2. `POST /bet` — ingest a bet

[`BetsController.ingest`](src/tournaments/bets.controller.ts#L17-L36) always answers `200` for a valid body,
both new and duplicate, so clients can retry safely. The work happens in
[`BetsService.ingest`](src/tournaments/bets.service.ts#L39-L99).

**Inside the Postgres transaction** ([lines 42–83](src/tournaments/bets.service.ts#L42-L83)):

1. **Store the bet once.** `INSERT … ON CONFLICT (external_bet_id) DO NOTHING RETURNING …`
   ([lines 44–48](src/tournaments/bets.service.ts#L44-L48)). `external_bet_id` has a unique index
   ([schema](prisma/schema.prisma#L35)), so a second insert with the same id returns no row instead of failing.
2. **Duplicate check.** If nothing was inserted, the existing row is loaded and compared field by field
   ([lines 50–56](src/tournaments/bets.service.ts#L50-L56),
   [`assertSamePayload`](src/tournaments/bets.service.ts#L102-L113)). A different `playerId`, `amount`,
   `currency` or `createdAt` throws `409 Conflict`, which rolls the transaction back. An identical payload continues,
   because it might still need to be counted somewhere (for example in a tournament created since the first attempt).
3. **Find matching tournaments.** `status = 'OPEN'`, same currency, and `starts_at <= createdAt <= ends_at`, read
   `FOR SHARE` ([lines 60–67](src/tournaments/bets.service.ts#L60-L67)). The shared row lock means finalization,
   which needs `FOR UPDATE`, has to wait until this bet commits. Bets don't block each other, because shared
   locks are compatible.
4. **Count it per tournament.** One `INSERT INTO tournament_bets … ON CONFLICT (tournament_id, bet_id) DO NOTHING
   RETURNING tournament_id` ([lines 69–78](src/tournaments/bets.service.ts#L69-L78)). The composite primary key
   ([schema](prisma/schema.prisma#L59)) is the real "once per tournament" guarantee. `RETURNING` only lists the
   tournaments this request newly counted.
5. **Timeout.** The transaction may wait behind a running finalization, so its timeout is `FINALIZE_TIMEOUT_MS + 5 s`
   instead of Prisma's 5 s default ([line 82](src/tournaments/bets.service.ts#L82)).

**After the commit, in Redis** ([lines 84–91](src/tournaments/bets.service.ts#L84-L91)): the service calls
`LeaderboardService.addBet` for **every** matching tournament, not only the newly counted ones. That is what lets
a retry repair a Redis write that failed the first time. The Lua script described below makes the extra calls
harmless.

**Response** ([lines 93–98](src/tournaments/bets.service.ts#L93-L98)): `duplicate` is `true` when the bet already
existed and nothing new was counted in Postgres; `countedTournamentIds` lists the newly counted tournaments.

#### 3. `GET /tournaments/:id/leaderboard` — read a page

[`TournamentsController.leaderboard`](src/tournaments/tournaments.controller.ts#L41-L65) validates the id as a
UUID and `limit` (1–100, default 50) and `offset` (≥ 0) through
[`LeaderboardQueryDto`](src/tournaments/dto/leaderboard-query.dto.ts).
[`TournamentsService.getLeaderboard`](src/tournaments/tournaments.service.ts#L78-L109) loads the tournament (404 if
missing) and branches on its status:

- **`OPEN`** — includes the period after `endsAt` but before the job has run. The page comes from Redis through
  [`LeaderboardService.getPage`](src/tournaments/leaderboard.service.ts#L79-L119) and `source` is `live`.
- **`FINALIZED`** — the page comes from `tournament_results` in Postgres, ordered by `placement` and then
  `player_id COLLATE "C" DESC` so tied players keep the same order they had in Redis
  ([lines 84–105](src/tournaments/tournaments.service.ts#L84-L105)). `source` is `final`.

#### 4. Worker — finalize

[`src/worker.ts`](src/worker.ts) starts a Nest application context (no HTTP server) from
[`WorkerModule`](src/worker.module.ts), which adds
[`FinalizationProcessor`](src/tournaments/finalization.processor.ts). For a `finalize` job it calls
[`FinalizationService.finalize`](src/tournaments/finalization.service.ts#L24-L60).

**Inside the Postgres transaction:**

1. `SELECT status, ends_at FROM tournaments WHERE id = … FOR UPDATE`
   ([lines 28–32](src/tournaments/finalization.service.ts#L28-L32)). This waits for every bet transaction holding
   `FOR SHARE` on the row. While the worker holds the lock, new bets for this tournament wait at their own
   `FOR SHARE`.
2. Early exits ([lines 34–36](src/tournaments/finalization.service.ts#L34-L36)): `not-found`, `already-finalized`
   (this is what makes a retried job safe), or `not-ended` (the job fired early, for example because of clock
   differences between hosts).
3. One `INSERT … SELECT` computes each player's `SUM(amount)` from `tournament_bets` and a placement with
   `RANK() OVER (ORDER BY SUM(amount) DESC)` ([lines 38–47](src/tournaments/finalization.service.ts#L38-L47)).
   `RANK()` gives tied players the same placement and skips the following numbers (1, 1, 3).
4. The tournament is marked `FINALIZED` with `finalized_at`
   ([lines 49–52](src/tournaments/finalization.service.ts#L49-L52)), and the transaction commits.

**Afterwards**, nothing is written to Redis. The live keys stay until they expire, but they are no longer read,
because the leaderboard endpoint now uses Postgres. Bets waiting on the lock then continue: their `SELECT … WHERE
status = 'OPEN'` no longer matches this tournament, so they are stored but not counted towards it. The processor
turns `not-ended` into a thrown error so BullMQ retries with backoff
([lines 30–35](src/tournaments/finalization.processor.ts#L30-L35)).

#### 5. Worker — recovery sweep

On startup the processor registers a repeating `sweep` job with `upsertJobScheduler`
([lines 20–26](src/tournaments/finalization.processor.ts#L20-L26)). "Upsert" means create or update, so restarts
or several workers don't create duplicate schedules. Each run asks
[`findOverdue`](src/tournaments/finalization.service.ts#L62-L72) for `OPEN` tournaments whose `endsAt` is more than
the grace period in the past (oldest first, up to 100), and finalizes them one by one. A failing tournament is
logged and skipped; it stays `OPEN` and is retried on the next run
([lines 36–53](src/tournaments/finalization.processor.ts#L36-L53)).

### Redis, explained from scratch

Each tournament has two keys, built in
[`LeaderboardService`](src/tournaments/leaderboard.service.ts#L48-L55):

| Key | Redis type | Contents |
| --- | --- | --- |
| `tournament:{<id>}:leaderboard` | Sorted set | Member = `playerId`, score = total cents |
| `tournament:{<id>}:bets` | Set | Internal bet ids (UUIDs) already added to the sorted set |

The `{…}` part is a **hash tag**: in Redis Cluster only that part decides which node stores the key, so both keys
of a tournament land together. A Lua script can only touch keys on the same node.

**A sorted set** is like a dictionary from member to number that Redis keeps sorted by the number. Adding to a
score or reading the top N is fast (logarithmic in the number of players), which is why live rankings use it
instead of `ORDER BY` in SQL on every request.

The commands the project uses:

| Command | What it does | Where |
| --- | --- | --- |
| `SADD key member` | Adds a member to a plain set. Returns `1` if it was new, `0` if it was already there. | Lua script: "have we counted this bet?" |
| `ZINCRBY key increment member` | Adds `increment` to the member's score, creating the member with that score if missing. | Lua script: add the bet amount to the player |
| `EXPIREAT key unix-seconds` | Deletes the key automatically at that timestamp. | Lua script: `max(endsAt, now)` + 7 days ([lines 65–67](src/tournaments/leaderboard.service.ts#L65-L67)) |
| `ZCARD key` | Number of members in the sorted set. | `getPage`: the `total` in the response |
| `ZREVRANGE key start stop WITHSCORES` | Members by rank, highest score first, with their scores. Ranks are 0-based and `stop` is inclusive. | `getPage`: ranks `offset` to `offset + limit − 1` |
| `ZCOUNT key min max` | Number of members with a score in `[min, max]`. A `(` prefix makes the bound exclusive. | `getPage`: `ZCOUNT key (score +inf` counts players **strictly** ahead of the page's first row |

`ZCARD` and `ZREVRANGE` are sent together in a `MULTI`/`EXEC` block (Redis runs them back to back), followed by a
separate `ZCOUNT` ([lines 88–105](src/tournaments/leaderboard.service.ts#L88-L105)). Placements are then computed
in TypeScript ([lines 107–117](src/tournaments/leaderboard.service.ts#L107-L117)): the first row's placement is
"players strictly ahead + 1", a row with the same score as the row before shares its placement, and any other row
gets its absolute rank `offset + i + 1`. That way a tie that crosses a page boundary still shows the right number
on page 2.

**The Lua script** ([lines 13–22](src/tournaments/leaderboard.service.ts#L13-L22)) is registered once with ioredis
`defineCommand` ([line 44](src/tournaments/leaderboard.service.ts#L44)) and runs inside Redis:

```lua
if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then   -- KEYS[1] = seen set, ARGV[1] = bet id
  redis.call('ZINCRBY', KEYS[2], ARGV[3], ARGV[2])  -- KEYS[2] = sorted set, ARGV[3] = amount, ARGV[2] = player
  redis.call('EXPIREAT', KEYS[1], ARGV[4])          -- ARGV[4] = expiry timestamp
  redis.call('EXPIREAT', KEYS[2], ARGV[4])
  return 1
end
return 0
```

Redis runs a script **atomically**: no other command runs between its lines. Without that, two concurrent
requests could both check "not seen yet" before either marked the bet as seen, and both would add the amount.

**How a retried bet is prevented from scoring twice.** Two independent guards work together:

1. **Postgres**: the `tournament_bets` primary key `(tournament_id, bet_id)` means the bet is recorded at most
   once per tournament, even with ten identical concurrent requests.
2. **Redis**: the `bets` set remembers which bet ids were already applied, and `ZINCRBY` only runs when `SADD`
   returns `1`.

The three retry cases:

| What happened on the first attempt | What the retry does |
| --- | --- |
| Postgres and Redis both succeeded | Postgres inserts nothing (`duplicate: true`). The Lua script runs again, `SADD` returns `0`, the score is unchanged. |
| Postgres committed, then the Redis call failed | The request fails, so the client retries. Postgres again inserts nothing, but this time `SADD` returns `1` and the score is added **once**. The response says `duplicate: true` because nothing new was counted in Postgres. |
| Postgres rolled back | Nothing was stored. The retry behaves like a first attempt. |

The Redis guard uses the internal `bets.id` (UUID), which is the same for every retry of one `externalBetId`.

### BullMQ, delayed jobs and the worker

**BullMQ is a job-queue library that keeps its jobs in Redis.** In this project it uses the **same Redis** as the
leaderboards: [`CoreModule`](src/core.module.ts#L16-L21) builds the connection from `REDIS_URL` with
[`bullConnectionFromUrl`](src/redis/redis-connection.ts). **It is not RabbitMQ**; there is no separate message
broker to run.

- **Producer:** the API adds jobs (`TournamentsService.create`).
- **Queue:** `tournament-finalization` ([`finalization.queue.ts`](src/tournaments/finalization.queue.ts)), with two
  job names: `finalize` (one delayed job per tournament) and `sweep` (repeating).
- **Worker:** `FinalizationProcessor` extends `WorkerHost`, so `@nestjs/bullmq` creates a BullMQ worker that
  pulls jobs from the queue and calls `process(job)`. It is only registered in the worker process, so the API
  never runs jobs.

**A delayed job** is saved in Redis immediately but only becomes available once its delay has elapsed. Because
the job lives in Redis rather than in an in-process timer, it survives API and worker restarts.

**A delayed job does not run at the exact scheduled instant.** The due time is the earliest it can run, not a
promise. In practice it can start later because:

- no worker is running or connected at that moment (it runs when a worker comes back);
- the worker is busy with other jobs;
- a previous attempt failed and the retry waits for its backoff;
- the grace period (`FINALIZE_GRACE_MS`) deliberately pushes it past `endsAt`.

It can also run before `endsAt` according to the worker's clock, for example when hosts' clocks differ. The
`not-ended` check handles that by failing the attempt so BullMQ retries. Correctness never depends on exact
timing: until finalization, the tournament is simply still `OPEN` and served live; the row lock ensures no bet is
counted after results are written; and the sweep covers jobs that were never added at all.

### Transactional outbox (concept)

In the original flow, a bet is committed to Postgres and **then** written to Redis. Those are two separate
systems, so there is a gap: if Redis is unavailable or the API process crashes between the two steps, Postgres has
the bet but the live leaderboard doesn't. The original code closes that gap only if the client retries (see the
table above). Final results are still correct either way, because they are computed from Postgres.

A **transactional outbox** removes the dependency on the client. In the **same** Postgres transaction that
records the bet, you also insert an "outbox" row meaning "this still needs to be applied to Redis". Because it
commits atomically with the bet, the two can't disagree. A background **relay** reads outbox rows, applies them
to Redis, and deletes them only after Redis has accepted them. If the relay crashes, it simply retries later; the
idempotent Lua script makes re-applying harmless. The result is **at-least-once delivery** (each update is applied
one or more times, never zero) with exactly-once *effect*.

### Later improvements

> **Not part of the original submission.** The items below come from a later pull request that was **closed
> without being merged**. Its code exists only on the `harden-ingestion-and-leaderboard` branch, not on `main`,
> so the file names below are not linked from this README.

| Change | What it does |
| --- | --- |
| **`leaderboard_outbox` table + relay** | The bet transaction inserts an outbox row for every newly counted `(tournament_id, bet_id)`. A worker job (`LeaderboardOutboxService`, every `LEADERBOARD_OUTBOX_EVERY_MS`, default 5 s) reads rows with `FOR UPDATE SKIP LOCKED` (so several workers can share the work), applies them to Redis, and deletes them in the same transaction. The API now logs a failed Redis write instead of returning an error. |
| **Leaderboard repair** | `LeaderboardRepairService` (every 5 min by default) compares the size of each tournament's Redis `bets` set with its count in `tournament_bets`. If Redis is behind, it rebuilds the board into temporary keys and swaps them in atomically with `RENAME`. The add-bets script refuses to write (returns `-1`) when only one of a tournament's two keys exists, since that means Redis lost data. |
| **`CLOSING` status** | Finalization is split into two transactions: a short one that flips `OPEN` → `CLOSING` under an exclusive Postgres advisory lock, then the aggregate and `FINALIZED`, with no lock held. Bets take the advisory lock in shared mode instead of `FOR SHARE`, so they only wait for the short close step, and the bet transaction timeout drops to 10 s. The sweep also resumes tournaments left in `CLOSING`. |
| **Smaller items** | A separate `leaderboard-maintenance` queue, so relay and repair can't delay finalization. Redis keys are deleted after finalization. The page read (`ZCARD`, `ZREVRANGE`, `ZCOUNT`) becomes one Lua script, so all three see the same data. A `/health` endpoint and Docker healthcheck. ioredis `maxRetriesPerRequest: 2` on the app's Redis client. A startup warning if Redis `maxmemory-policy` isn't `noeviction`. A per-player maximum score (`422`), cursor pagination, and a log warning for bets that arrive after their tournament closed. |

### Design tradeoffs and production improvements

**Required by the assignment** (and implemented in the original submission): the three endpoints, the inclusive
`startsAt <= createdAt <= endsAt` rule, counting a bet in several tournaments, counting each `externalBetId` at
most once per tournament with an idempotent success response, Redis for the live ranking, and a BullMQ job that
writes final placements to Postgres after `endsAt`.

**Already in the original as extra robustness:** the `409` for a reused `externalBetId` with a different payload,
the row locks that stop late bets from changing final results, job retries with backoff, the recovery sweep, and
computing final results from Postgres rather than copying them from Redis.

**Main tradeoffs in the original design:**

- **Two stores, no distributed transaction.** Postgres is authoritative and Redis is a fast, derived view. That
  keeps the final results correct, but the live board can lag Postgres until a client retries.
- **One Postgres row per bet per tournament.** This gives exact idempotency and an audit trail, at the cost of
  write volume.
- **Correctness through row locks.** Simple and verifiable, but the finalizer holds `FOR UPDATE` for the whole
  aggregate. On a very large tournament, bets for *that* tournament wait for up to `FINALIZE_TIMEOUT_MS`.
- **Live page reads aren't one snapshot.** The `ZCOUNT` runs after the `MULTI`, so a bet landing in between can
  make one placement briefly off by one.

**Optional hardening for production**, roughly in order of value:

| Area | Original behavior | Realistic improvement |
| --- | --- | --- |
| Redis failure during a bet | Request fails after the Postgres commit; the client's retry repairs Redis. With ioredis defaults, a request can wait through many reconnect retries first. | Transactional outbox + relay. Fail fast on Redis commands. Run Redis with `noeviction` and persistence (AOF). |
| Redis data loss mid-tournament | Live board stays short until finalization (which is still correct). | Rebuild a tournament's sorted set from `tournament_bets`. |
| Finalization lock | `FOR UPDATE` held for the whole aggregate. | Close first (`CLOSING`), aggregate afterwards with no lock held. |
| Missed or failed jobs | Sweep every 60 s; failed jobs kept in Redis (`removeOnFail: false`). | Alert when the sweep finds anything overdue. The BullMQ connection retries forever (`maxRetriesPerRequest: null`, required by workers), so `queue.add` in the API may wait during a Redis outage rather than fail; a fail-fast producer connection makes the "log and let the sweep handle it" path predictable. |
| Worker and queue health | Logs only. | Metrics and alerts on: failed and delayed job counts, time from `ends_at` to `finalized_at`, worker liveness, outbox age (once added), Redis memory. Health endpoints for API and worker. |

### 45–60 second interview explanation

> It's a NestJS service with two processes from one codebase: an API and a BullMQ worker. Postgres is the source
> of truth and Redis holds the live leaderboards. Creating a tournament inserts it in Postgres and schedules a
> delayed BullMQ job for the end time plus a short grace period. When a bet arrives, one Postgres transaction
> stores it by `externalBetId`, finds the open tournaments whose window contains `createdAt`, and records the bet
> per tournament under a composite primary key, so it counts at most once. After the commit, a Lua script in Redis
> adds the amount to a sorted set, but only if the bet id is new to that tournament, so retries never double
> count. While a tournament is open the leaderboard comes from Redis; once the worker finalizes it, it locks the
> tournament row, computes `SUM` and `RANK` from Postgres, writes the results, and marks it finalized, and from
> then on the leaderboard comes from Postgres. A sweep every minute catches any tournament whose job was missed.

### Likely follow-up questions

**Why not compute final results from Redis?** Redis may be behind or lose data; Postgres is durable and locked
against late bets. It costs one aggregate query per tournament.

**What if Redis is down when a bet arrives?** The bet is committed in Postgres and the request fails. A retry
counts it in Redis exactly once. Final results are unaffected. An outbox would remove the reliance on retries.

**How do you stop a bet from being counted after finalization?** Bets hold `FOR SHARE` on the tournament row and
the finalizer takes `FOR UPDATE`, so they can't overlap. Once finalized, the `status = 'OPEN'` filter excludes it.

**What if the worker is down at `endsAt`?** The delayed job waits in Redis and runs when a worker is back. If the
job was never created, the sweep finds the overdue tournament.

**Is the finalize job safe to run twice?** Yes. A finalized tournament returns `already-finalized`, and result
inserts use `ON CONFLICT DO NOTHING`.

**Can you run several workers?** Yes. The row lock serializes finalization of one tournament, and the job
scheduler is upserted, so there's one sweep schedule.

**How are ties handled?** Competition ranking (1, 1, 3): `RANK()` in SQL, and "players strictly ahead + 1" via
`ZCOUNT` in Redis.
