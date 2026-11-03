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
| `GET` | `/tournaments/:id/leaderboard` | `?limit=50&offset=0` or `?limit=50&cursor=…` (limit 1–100) | `200` and a page of placements |
| `GET` | `/health` | | `200` when Postgres and Redis are reachable, otherwise `503` |

The OpenAPI spec is generated from the same DTO classes that validate requests, so the docs can't drift from the
validation rules. UI: `/docs`, raw JSON: `/docs-json`.

Errors: `400` for invalid input, `404` for an unknown tournament, `409` when an `externalBetId` is re-sent
with a different payload, and `422` when a bet would push a player's score past the maximum (see
[Assumptions](#assumptions)).

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
  ],
  "nextCursor": null
}
```

Scores are in cents, like `amount`. `source` is `live` (Redis) while the tournament runs (`OPEN`) and while its
results are being written (`CLOSING`), and `final` (Postgres) once it is `FINALIZED`.

**Paging.** `offset` works as before. Each page also returns `nextCursor` (or `null` on the last page); pass it back
as `?cursor=` to read the next page. On final results the cursor continues after the last row (keyset) instead of
making Postgres skip `offset` rows, so deep pages stay fast. Redis ranges are cheap at any offset, so live cursors
just carry the offset, and a live cursor keeps working if the tournament is finalized between two pages.

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
        FP["FinalizationProcessor<br/>finalize, sweep + repair jobs"]
        FS["FinalizationService"]
        RS["LeaderboardRepairService"]
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
    FS -- "drop live keys" --> ZSET & SEEN
    FP --> RS
    RS -- "rebuild from" --> TB
    RS -- "swap in rebuilt keys" --> ZSET & SEEN
```

### What lives where

| Store | Holds | Why |
| --- | --- | --- |
| **Postgres** | Tournaments, every bet, which bets counted in which tournament, the Redis outbox, final results | Source of truth: durable, transactional, enforces "once per tournament" with a primary key |
| **Redis: sorted sets** | Live score per player per tournament | Fast ranking (`ZINCRBY`, `ZREVRANGE`) for the live leaderboard |
| **Redis: BullMQ** | Delayed finalize jobs, a periodic sweep and a periodic leaderboard repair | Runs the snapshot after `endsAt`, with retries |

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
    API->>PG: SELECT OPEN tournaments where<br/>startsAt ≤ createdAt ≤ endsAt (same currency)
    API->>PG: Shared advisory lock per tournament,<br/>then re-read which are still OPEN
    API->>PG: Advisory lock on the player, then check<br/>the score stays ≤ 2^53 − 1 (else 422)
    API->>PG: INSERT tournament_bets + leaderboard_outbox<br/>ON CONFLICT DO NOTHING (one statement)
    API->>PG: COMMIT
    loop each matching tournament
        API->>R: Lua: if SADD(seen, betId) then ZINCRBY(board, amount, player)
    end
    API-->>C: 200 { duplicate, countedTournamentIds }
```

- **Once per tournament** is guaranteed in Postgres by the `tournament_bets` primary key `(tournament_id, bet_id)`.
  Ten identical requests at the same moment still count once (this is tested).
- **Redis is idempotent too.** The Lua script only adds to the score the first time it sees a bet id for a
  tournament, so applying the same bet again (a client retry, the outbox relay, a rebuild) never double counts.
- **Redis can't make a bet fail.** Every counted bet also gets a `leaderboard_outbox` row in the same statement,
  so it commits atomically with the count. If the Redis write right after the commit fails, the API logs it and
  still returns `200`, and the worker's **outbox relay** (every 5 s, `LEADERBOARD_OUTBOX_EVERY_MS`) applies the
  row and deletes it. Clients no longer need to retry to fix the live board. The Redis client retries a command at
  most twice, so an outage doesn't make requests hang either.
- **Locks don't touch the tournament row.** Each bet takes a *shared* advisory lock per matching tournament, and
  finalization takes the same lock *exclusively* only to close the tournament (see below). Unlike `FOR SHARE`, an
  advisory lock lives in Postgres's lock table and never writes to the tournament row, so thousands of concurrent
  bets on one popular tournament don't contend on it. Locks are taken in tournament id order, so bets can't
  deadlock on each other. After taking them the bet re-reads which tournaments are still `OPEN`.
- **A bet can count in several tournaments.** Every open tournament whose window contains `createdAt` gets it.
- **Scores are capped at 2^53 − 1 cents** (about $90 trillion), the largest value Redis scores and JSON numbers
  hold exactly. A bet that would cross it in any tournament is rejected with `422` and not stored. A per-player
  advisory lock makes two concurrent bets of the same player take turns, so they can't both pass the check.
- **Late bets are logged.** A bet whose `createdAt` falls in a tournament that was already closed or finalized
  isn't counted there, and the API logs a warning naming the tournament. The check only runs for bets older than
  `FINALIZE_GRACE_MS`, so live traffic doesn't pay for it.

### 2. Live leaderboard: `GET /tournaments/:id/leaderboard`

- **Before finalization** (`OPEN` or `CLOSING`), the page is read from the Redis sorted set by one Lua script (`ZCARD`, `ZREVRANGE`
  and the `ZCOUNT` used for the first row's tie placement), so the page, total and placements come from the
  same moment even while bets arrive.
- **After finalization**, the page is read from `tournament_results` in Postgres.
- **Ties share a placement** (competition ranking): scores 500, 400, 400, 50 → placements 1, 2, 2, 4.
  Placements are absolute, so page 2 doesn't restart at 1.

### 3. Tournament lifecycle and finalization

```mermaid
stateDiagram-v2
    direction LR
    [*] --> OPEN: POST /tournaments<br/>(delayed BullMQ job scheduled<br/>for endsAt + grace)
    OPEN --> OPEN: bets in window<br/>update Redis + Postgres
    OPEN --> CLOSING: finalize job runs<br/>(or the 60 s sweep)
    CLOSING --> FINALIZED: placements written
    FINALIZED --> [*]: leaderboard served<br/>from tournament_results
```

When the job runs, the worker finalizes in **two short transactions**, so bets never wait for the aggregate:

1. **Close.** It takes the tournament's advisory lock *exclusively*, which waits for bets in flight (they hold it
   shared) and holds new ones back, and sets the status to `CLOSING`. This transaction only flips one row, so
   bets for that tournament wait milliseconds, not the length of the aggregate. Bets that were held back then
   re-read the status and skip the tournament. From here on no bet can be counted.
2. **Write results**, with no lock held. It computes placements with `SUM(amount)` per player and
   `RANK() OVER (ORDER BY score DESC)`, inserts them into `tournament_results`, and marks the tournament
   `FINALIZED`. Nothing can change the bets of a `CLOSING` tournament, so this step can take as long as it needs
   (up to `FINALIZE_TIMEOUT_MS`) without blocking anyone.

If the worker dies between the two, the tournament stays `CLOSING`. The job retry or the sweep resumes it at step 2.

After the commit it **deletes the tournament's live Redis keys**, since the leaderboard is now served from
Postgres. The set of counted bet ids holds one entry per bet, so this is most of a tournament's Redis memory. If
the delete fails, the keys still expire after `LEADERBOARD_TTL_AFTER_END_SECONDS`.

The job is idempotent (running it twice is a no-op) and retries with exponential backoff. A **sweep job every
60 s** finalizes any overdue tournament whose job was never enqueued, for example because Redis was down when the
tournament was created. A failure on one tournament is logged and doesn't stop the sweep from handling the rest;
that tournament stays `OPEN` or `CLOSING` and is retried by the next sweep.

### 4. Leaderboard repair

The outbox relay covers a single lost Redis write, but not a leaderboard Redis lost as a whole after its outbox
rows were relayed. Nor does it cover the case where only the board was evicted: the bet ids are still marked as
counted, so their scores are never added back. A **repair job every 5 minutes** (`LEADERBOARD_REPAIR_EVERY_MS`)
covers both cases:

1. For every started tournament that isn't finalized yet, it compares the number of counted bets in Postgres with the size
   of the Redis set of counted bet ids, and checks the board still exists.
2. If Redis is behind, it rebuilds both keys from `tournament_bets` (1,000 bets per query) into **temporary keys**
   and swaps them in atomically with `RENAME`, so the live board never shows up empty halfway through.
3. Bets that reached the old keys during the copy were discarded by the swap, so it replays all bets onto the
   new keys. The Lua script is idempotent per bet, so this pass only adds what the first one missed.

A bet whose Redis write is still in flight can make a tournament look out of sync. The rebuild is correct in
that case too, just unnecessary.

On startup the API and worker warn if Redis's `maxmemory-policy` isn't `noeviction`. Leaderboard keys have a TTL,
so even the `volatile-*` policies may evict them. Managed Redis services often block `CONFIG`; then the check is
skipped.

---

## Data model

```mermaid
erDiagram
    tournaments ||--o{ tournament_bets : "counts"
    bets ||--o{ tournament_bets : "counted in"
    tournaments ||--o{ tournament_results : "final placements"
    tournament_bets ||--o| leaderboard_outbox : "awaiting Redis"

    tournaments {
        uuid id PK
        string name
        string currency "default USD"
        timestamptz starts_at
        timestamptz ends_at
        enum status "OPEN | CLOSING | FINALIZED"
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
    leaderboard_outbox {
        uuid tournament_id PK, FK
        uuid bet_id PK, FK
        timestamptz created_at
    }
```

Schema: [`prisma/schema.prisma`](prisma/schema.prisma). Migrations: [`prisma/migrations/`](prisma/migrations).

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
├── health/                     GET /health (Postgres + Redis readiness)
├── prisma/                     PrismaService
├── redis/                      ioredis client provider + BullMQ connection options
└── tournaments/
    ├── tournaments.module.ts       The Tournaments module
    ├── tournaments.config.ts       Typed, validated settings (env vars with defaults)
    ├── tournaments.controller.ts   POST /tournaments, GET leaderboard
    ├── tournaments.service.ts      Create tournament + schedule job, read leaderboard
    ├── bets.controller.ts          POST /bet
    ├── bets.service.ts             Bet ingestion (Postgres transaction + outbox, then Redis)
    ├── advisory-locks.ts           Advisory lock namespaces (tournament, player)
    ├── leaderboard.service.ts      Redis sorted sets + Lua scripts (add, read page, swap in a rebuild)
    ├── leaderboard-cursor.ts       Opaque page cursors (offset or keyset)
    ├── leaderboard-outbox.service.ts  Relays leaderboard_outbox rows into Redis
    ├── leaderboard-repair.service.ts  Rebuilds live leaderboards that are behind Postgres
    ├── finalization.queue.ts       Queue name, job names and ids
    ├── finalization.service.ts     Closes a tournament, then writes final placements
    ├── finalization.processor.ts   BullMQ processor (finalize, sweep, outbox relay, repair), worker only
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
| `npm run test:unit` | 88 unit tests with mocked Prisma, Redis, BullMQ and config (a few seconds) | No |
| `npm run test:e2e` | 37 end-to-end tests against real Postgres and Redis | Yes |
| `npm test` | Both (start Postgres + Redis first with `npm run infra`) | Yes |
| `npm run verify` | Type check, unit tests, `npm run infra`, e2e tests; stops at the first failure | Yes |

```bash
npm run verify
```

**Unit tests** (`test/unit/`) build each class through Nest's `Test.createTestingModule` (or its constructor) with
mocks in place of its dependencies. They cover the logic in isolation: job scheduling and retry options, duplicate
detection, the 409 rule, the score limit, late-bet logging, live and final leaderboard sources, tie placements
across page boundaries, cursors, Redis key expiry and cleanup, the outbox relay, the rebuild and its sync check,
the eviction-policy warning, every finalization outcome including resuming a `CLOSING` tournament, the worker's
job routing, sweep and repair, and config validation.

**End-to-end tests** boot the real Nest/Fastify app against a separate **`tournaments_test`** database (created
and migrated automatically) and **Redis DB 15**, so dev data is never touched. The real `Clock` is swapped for a
`FakeClock` with `overrideProvider`, so "after the tournament ended" is a single `clock.set(...)`. They cover:

- **Bet ingestion:** counting, inclusive window bounds, other currencies, several tournaments, validation, timezones
- **Duplicates:** re-sent bets, 10 concurrent identical bets, repair after a lost Redis write, `409` on a payload mismatch
- **Leaderboard:** ordering, shared placements on ties, offset and cursor pagination (live, final, and a live
  cursor continued after finalization), query validation, `404`
- **Finalization:** delayed BullMQ job scheduled, final placements, late bets ignored and logged, idempotency,
  consistent tie order, no early finalization, live Redis keys freed, no counting once `CLOSING`, and bets racing
  finalization never counted after the results
- **Outbox:** one row per counted bet, a bet accepted while Redis rejects writes and then relayed, no keys
  recreated for finalized tournaments
- **Leaderboard repair:** intact boards left alone, rebuild after a full Redis wipe and after only the board was
  evicted, no temporary keys left behind
- **Health and API docs:** `/health` reports both stores up, Swagger UI is served and the spec lists every endpoint

### CI (GitHub Actions)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main`, every pull request, and on
demand. It has three parallel jobs:

| Job | What it does |
| --- | --- |
| Type check, build, unit tests | `npm ci`, `typecheck`, `build`, unit tests |
| End-to-end tests | Same e2e suite against Postgres 16 and Redis 7 service containers |
| Docker stack smoke test | `docker compose up --build` (waits for the API's `/health` healthcheck), then checks `/health`, `/docs-json` and that the worker started |

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
| `FINALIZE_TIMEOUT_MS` | `60000` | Upper bound for the placements transaction (it blocks no bets) |
| `FINALIZE_SWEEP_EVERY_MS` | `60000` | How often the worker finalizes overdue tournaments whose job was lost |
| `FINALIZE_SWEEP_BATCH_SIZE` | `100` | Overdue tournaments handled per sweep, oldest first |
| `LEADERBOARD_OUTBOX_EVERY_MS` | `5000` | How often the worker applies outbox rows to Redis |
| `LEADERBOARD_REPAIR_EVERY_MS` | `300000` | How often the worker rebuilds live leaderboards that are behind Postgres |
| `LEADERBOARD_TTL_AFTER_END_SECONDS` | `604800` | How long live Redis keys are kept after `endsAt` (7 days) if finalization couldn't delete them |

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
- **`amount`** is a positive integer in cents, at most 2^31 − 1. A player's score in a tournament is capped at
  2^53 − 1 cents, the limit up to which Redis scores and JSON numbers are exact. A bet that would cross it gets
  `422` and isn't stored. Rejecting the whole bet, rather than counting it only in tournaments still under the
  limit, keeps one rule for every tournament the bet falls into.
- **`externalBetId` is globally unique.** Re-sending it with a different payload is a client bug and gets `409`.
- **Duplicates return `200` with `duplicate: true`.** If a re-sent bet now matches a tournament created after it
  first arrived, it counts there (still at most once per tournament).
- **Bets arriving after a tournament closes** (beyond `FINALIZE_GRACE_MS`) don't change the final results.
  They're stored, and the API logs a warning naming the tournament they missed.
- **A bet succeeds once it's in Postgres.** If Redis is down, the response is still `200` and the live board
  catches up through the outbox within `LEADERBOARD_OUTBOX_EVERY_MS`.
- **Ties share a placement.** Within a tie, the order is player id descending by bytes (Redis's natural order). The
  final results query uses `COLLATE "C"` to match, so the order doesn't change after finalization.
- **Out of scope:** auth, rate limiting, and endpoints to list or update tournaments.

## Tradeoffs

- **Final placements are computed from Postgres, not copied from Redis.** The sums are the same, but Postgres is
  durable and locked against late bets, while Redis could be evicted or behind after a partial failure. The cost
  is one aggregate query per tournament at finalization, which the `(tournament_id, player_id)` index covers.
- **One Postgres write per bet per tournament.** This gives exact idempotency and an audit trail, at the cost of
  write volume. At very high throughput you'd batch inserts or put a queue in front of ingestion.
- **The outbox costs two extra writes per counted bet** (insert in the bet transaction, batched delete by the
  relay). In return a counted bet always reaches Redis without the client's help. The API still writes Redis
  directly after its commit so the live board updates immediately; the relay replays those rows as no-ops.
- **Lost Redis data is repaired by a periodic job.** The outbox only holds bets not yet relayed, so a Redis wipe
  after that is caught by the repair job within `LEADERBOARD_REPAIR_EVERY_MS`. Each repair run counts the bets of
  every unfinalized, started tournament, which is cheap for a handful of tournaments but would want a cheaper
  signal at scale.
- **The score limit costs a query and a lock per counted bet.** The check sums the player's earlier bets in each
  matching tournament (covered by the `(tournament_id, player_id)` index), and the advisory lock makes that
  player's concurrent bets take turns. Different players never wait for each other.
- **Advisory locks instead of row locks.** Concurrent bets for the same tournament only share a lock and never
  write to its row. A bet waits only while that tournament is being *closed*, a transaction that flips one
  status, so the bet transaction keeps a fixed 10 s timeout however large tournaments get. The cost is a lock
  table entry per matching tournament per bet, and the rule that every writer must go through the lock: code that
  counts bets without it would break the "nothing counted after closing" guarantee.
- **Finalization is one aggregate statement, not chunked.** Since it holds no lock, its only limit is
  `FINALIZE_TIMEOUT_MS`. Tournaments too large for one `INSERT … SELECT` within that would need the ranking split
  into ranges, which the `CLOSING` state now makes safe to do across several transactions.
- **Redis keys are deleted at finalization**, and as a fallback expire 7 days after `endsAt` (or the latest write,
  if later). After that, Postgres is the only source.
- **No RabbitMQ.** The task asks for BullMQ, which runs on the same Redis, so there's no extra broker to operate.
- **Pinned to NestJS 11 and Prisma 6** (stable, well-known APIs) rather than the newest major versions.
- **`@fastify/static` is pinned to 10.1.3.** Swagger UI needs it on Fastify. Later 10.1.x releases depend on an
  ESM-only `content-disposition`, which Jest can't load on Node below 24.9. 10.1.3 still satisfies the NestJS
  peer range.
