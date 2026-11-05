# Tournaments Service

Create tournaments, send bets, see a **live leaderboard from Redis**, and get **final placements in Postgres** when a
tournament ends. A **BullMQ** job closes each tournament on time.

**Stack:** NestJS 11 · Fastify · Postgres 16 + Prisma 6 · Redis 7 · BullMQ · Jest · Docker Compose

- [How it works](#how-it-works)
- [Diagrams](#diagrams)
- [Key algorithms](#key-algorithms)
- [Run it](#run-it)
- [API](#api)
- [Tests](#tests)
- [Configuration](#configuration)
- [Assumptions and tradeoffs](#assumptions-and-tradeoffs)
- [In a bigger project](#in-a-bigger-project)

---

## How it works

**The parts**

- **API process** ([`src/main.ts`](src/main.ts)): three endpoints, plus a small UI at `/`.
- **Worker process** ([`src/worker.ts`](src/worker.ts)): a separate process from the same code. Its only job handler
  is `FinalizationProcessor`, which runs two job types: `finalize` and `sweep`.
- **Postgres** (source of truth), tables:
  - `tournaments`: status `OPEN` or `FINALIZED`
  - `bets`: each bet once, unique `external_bet_id`
  - `tournament_bets`: which bet counted in which tournament
  - `tournament_results`: final placements
- **Redis** has two uses:
  - **Live leaderboard**, two keys per tournament:
    - `tournament:{<id>}:leaderboard`: a sorted set, player → score (`boardKey` in the code);
    - `tournament:{<id>}:bets`: a set of bet ids already counted (`seenKey` in the code).
  - **BullMQ:** the queue `tournament-finalization` is stored in the same Redis. There is no RabbitMQ.

**The flow** (each step names the function that runs it)

1. **`POST /tournaments` → `TournamentsService.create`:** saves the tournament as `OPEN` and adds a delayed `finalize`
   job to the queue, due at `endsAt` + 5 s.
2. **`POST /bet` → `BetsService.ingest`:** one Postgres transaction saves the bet (once per `externalBetId`), finds
   the matching `OPEN` tournaments, and saves one `tournament_bets` row per tournament.
3. **Then, in the same request → `LeaderboardService.addBet`:** a Lua script adds the amount to the player's score
   **only if this bet id is not in `seenKey` yet**.
4. **`GET /tournaments/:id/leaderboard` → `TournamentsService.getLeaderboard`:** while `OPEN`, it calls
   `LeaderboardService.getPage` (Redis); once `FINALIZED`, it reads `tournament_results` (Postgres).
5. **`finalize` job, at `endsAt` + 5 s → `FinalizationService.finalize`:** sums each player's bets, ranks them,
   saves `tournament_results` and sets the status to `FINALIZED`. If it fails, BullMQ retries it.
6. **`sweep` job, every 60 s → `FinalizationService.findOverdue`, then `finalize` for each:** a safety net for
   tournaments still `OPEN` after `endsAt` + 5 s (for example, if Redis was down when step 1 added the job). Normally
   it finds nothing.
7. **Cleanup:** both Redis keys expire 7 days after `endsAt`.

**Where each name lives**

| Name | File |
| --- | --- |
| `TournamentsService.create`, `.getLeaderboard` | [`tournaments.service.ts`](src/tournaments/tournaments.service.ts) |
| `BetsService.ingest` | [`bets.service.ts`](src/tournaments/bets.service.ts) |
| `LeaderboardService.addBet`, `.getPage`, `boardKey`, `seenKey` | [`leaderboard.service.ts`](src/tournaments/leaderboard.service.ts) |
| Queue `tournament-finalization`, jobs `finalize` and `sweep` | [`finalization.queue.ts`](src/tournaments/finalization.queue.ts) |
| `FinalizationProcessor`: schedules `sweep`, runs both jobs | [`finalization.processor.ts`](src/tournaments/finalization.processor.ts) |
| `FinalizationService.finalize`, `.findOverdue` | [`finalization.service.ts`](src/tournaments/finalization.service.ts) |

---

## Diagrams

### The whole system

Numbers match the flow above.

```mermaid
flowchart TB
    Client(["Client / game backend"])

    subgraph API["API process"]
        direction LR
        TAPI["POST /tournaments<br/>TournamentsService.create"]
        BAPI["POST /bet<br/>BetsService.ingest"]
        LAPI["GET /tournaments/:id/leaderboard<br/>TournamentsService.getLeaderboard"]
    end

    subgraph RD["Redis"]
        direction TB
        LB[("tournament:{id}:leaderboard<br/>tournament:{id}:bets")]
        Q[("queue tournament-finalization<br/>jobs: finalize, sweep")]
    end

    subgraph PG["Postgres: source of truth"]
        direction TB
        T[("tournaments")]
        B[("bets + tournament_bets")]
        TR[("tournament_results")]
    end

    W["Worker process<br/>FinalizationProcessor"]

    Client --> TAPI
    Client --> BAPI
    Client --> LAPI

    TAPI -- "1: save OPEN" --> T
    TAPI -- "1: add delayed finalize job" --> Q
    BAPI -- "2: one transaction" --> B
    BAPI -- "3: LeaderboardService.addBet" --> LB
    LAPI -- "4: while OPEN: getPage" --> LB
    LAPI -- "4: once FINALIZED" --> TR
    Q -- "5, 6: job is due" --> W
    W -- "5, 6: FinalizationService.finalize" --> TR
```

### The worker: two jobs, one function

```mermaid
flowchart LR
    A["TournamentsService.create"] -- "queue.add('finalize')<br/>delay = endsAt − now + 5 s" --> Q[("queue<br/>tournament-finalization")]
    S["FinalizationProcessor<br/>onApplicationBootstrap"] -- "upsertJobScheduler('sweep')<br/>every 60 s" --> Q
    Q -- "job is due" --> P["FinalizationProcessor.process(job)"]
    P -- "'finalize'" --> F["FinalizationService.finalize(id)"]
    P -- "'sweep'" --> O["FinalizationService.findOverdue()<br/>OPEN and past endsAt + 5 s"]
    O -- "for each id" --> F
    F --> R[("Postgres<br/>tournament_results<br/>status FINALIZED")]
```

`@Processor('tournament-finalization')` makes BullMQ call `FinalizationProcessor.process()` for every job in the
queue. Both jobs end in the same `FinalizationService.finalize(id)`, which is why the sweep code lives in the
`finalization.*` files.

### Who saves what, and when

| When | Function | Postgres | Redis |
| --- | --- | --- | --- |
| Tournament created | `TournamentsService.create` | `tournaments` row, `OPEN` | Delayed job, id `finalize_<id>` |
| Bet arrives | `BetsService.ingest`, then `LeaderboardService.addBet` | `bets` + `tournament_bets` | Bet id into `seenKey`, score into `boardKey` |
| `endsAt` + 5 s | `finalize` job → `FinalizationService.finalize` | `tournament_results`, status `FINALIZED` | The job is removed when done |
| Every 60 s | `sweep` job → `findOverdue`, then `finalize` | Same, only for overdue tournaments | — |
| 7 days after `endsAt` | Redis itself | — | Both keys expire |

---

## Key algorithms

### 1. Which tournaments a bet counts in (`BetsService.ingest`)

A bet counts in **every** tournament where:

```sql
status = 'OPEN' AND currency = bet.currency AND starts_at <= bet.createdAt AND ends_at >= bet.createdAt
```

The bet's `createdAt` decides, not when it arrives. Code:
[`bets.service.ts`](src/tournaments/bets.service.ts#L60-L67).

### 2. Duplicates (`BetsService.ingest`)

| Request | Result |
| --- | --- |
| New `externalBetId` | Saved and counted: `duplicate: false` |
| Same id, same payload | Nothing new: `duplicate: true` |
| Same id, different payload | `409 Conflict` |

Postgres guarantees this with a unique `external_bet_id` and the primary key `(tournament_id, bet_id)`. Code:
[`bets.service.ts`](src/tournaments/bets.service.ts#L39-L99).

### 3. Live score: add once, never twice (`LeaderboardService.addBet`)

After the commit, for each matching tournament, `addBet` runs the Lua script `ADD_BET_LUA` in Redis as one step:

```text
if SADD seenKey <betId> returns 1                    (bet id not seen before)
    ZINCRBY boardKey <amount> <playerId>
    EXPIREAT seenKey and boardKey at max(endsAt, now) + 7 days
```

If the Redis write failed, the client's retry adds the missing amount. If it succeeded, the retry adds nothing. Code:
[`leaderboard.service.ts`](src/tournaments/leaderboard.service.ts#L13-L22).

### 4. Placement with ties (`LeaderboardService.getPage`)

Tied players share a placement, and the next one skips: scores 500, 400, 400, 50 give placements **1, 2, 2, 4**.

- Read the page, highest first: `ZCARD boardKey` (total) and `ZREVRANGE boardKey offset offset+limit−1 WITHSCORES`.
- First row: placement = (players with a higher score) + 1, using `ZCOUNT boardKey (score +inf`.
- Each next row: if it has the same score as the row before, it gets the same placement; otherwise its placement is
  its position, `offset + i + 1`.

Code: [`leaderboard.service.ts`](src/tournaments/leaderboard.service.ts#L79-L119).

### 5. Finalize (`FinalizationService.finalize`)

One transaction ([`finalization.service.ts`](src/tournaments/finalization.service.ts#L24-L60)):

1. Lock the tournament row (`FOR UPDATE`). This waits for bets in progress; bets that come later see it's no longer
   `OPEN` and don't count.
2. Check the state:
   - not found, or already `FINALIZED`: returns `not-found` / `already-finalized` and does nothing, so running twice
     is safe;
   - `endsAt` still in the future: returns `not-ended`; `FinalizationProcessor` then throws, so BullMQ retries later;
   - otherwise, continue (and return `finalized`).
3. Compute the results from Postgres, not from Redis:

   ```sql
   INSERT INTO tournament_results (tournament_id, player_id, score, placement)
   SELECT tournament_id, player_id, SUM(amount), RANK() OVER (ORDER BY SUM(amount) DESC)
   FROM tournament_bets WHERE tournament_id = $1
   GROUP BY tournament_id, player_id
   ```

4. Set the status to `FINALIZED`.

`RANK()` gives the same 1, 2, 2, 4 placements as the live board.

### 6. Timing

| What | Rule | Setting (default) |
| --- | --- | --- |
| `finalize` job delay | `max(0, endsAt − now + FINALIZE_GRACE_MS)` | `FINALIZE_GRACE_MS` (5 s) |
| Retries | exponential backoff: 5 s, 10 s, 20 s, … | `FINALIZE_ATTEMPTS` (10), `FINALIZE_BACKOFF_MS` (5 s) |
| `sweep` | `OPEN` and `endsAt < now − FINALIZE_GRACE_MS`, oldest first | `FINALIZE_SWEEP_EVERY_MS` (60 s), `FINALIZE_SWEEP_BATCH_SIZE` (100) |
| Redis keys | expire at `max(endsAt, now)` + TTL | `LEADERBOARD_TTL_AFTER_END_SECONDS` (7 days) |

A delayed job runs **at or after** its due time. If the worker is down, the job runs when the worker comes back.

---

## Run it

Requires Docker:

```bash
npm run up      # Postgres, Redis, migrations, API and worker
npm run logs    # follow API and worker logs
npm run down    # stop
```

- **UI:** <http://localhost:3000/>: create tournaments, send bets, watch the leaderboard
- **Swagger:** <http://localhost:3000/docs>

Without Docker for the app itself (Node 20+): `npm install`, `cp .env.example .env`, `npm run infra`,
`npx prisma migrate deploy`, then `npm run start:dev` (API) and `npm run start:worker:dev` (worker) in two terminals.

---

## API

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| `POST` | `/tournaments` | `{ name, startsAt, endsAt, currency? }` | `201` + the tournament |
| `POST` | `/bet` | `{ externalBetId, playerId, amount, currency, createdAt }` | `200`, also for duplicates |
| `GET` | `/tournaments/:id/leaderboard` | `?limit=50&offset=0` (limit 1–100) | `200` + a page of placements |

Errors: `400` invalid input, `404` unknown tournament, `409` same `externalBetId` with a different payload.

```json
{
  "tournamentId": "…", "status": "OPEN", "source": "live", "total": 3, "limit": 50, "offset": 0,
  "items": [
    { "placement": 1, "playerId": "alice", "score": 500 },
    { "placement": 2, "playerId": "carol", "score": 400 },
    { "placement": 2, "playerId": "bob",   "score": 400 }
  ]
}
```

Scores are in cents. `source` is `live` (Redis) while open and `final` (Postgres) after finalization.

---

## Tests

| Command | What runs | Needs Docker |
| --- | --- | --- |
| `npm run test:unit` | 39 unit tests | No |
| `npm run test:e2e` | 23 end-to-end tests on real Postgres and Redis | Yes |
| `npm test` | Both | Yes |

The e2e tests use a separate database and a fake clock to jump past `endsAt`. They cover bets, duplicates (including
10 identical bets at once), ties, pages and finalization. [CI](.github/workflows/ci.yml) runs them on every push and
pull request.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/tournaments` | Postgres |
| `REDIS_URL` | `redis://localhost:6379` | Redis (leaderboards + BullMQ) |
| `PORT` | `3000` | API port |
| `FINALIZE_GRACE_MS` | `5000` | Wait after `endsAt` before finalizing |
| `FINALIZE_ATTEMPTS` | `10` | Tries of the `finalize` job |
| `FINALIZE_BACKOFF_MS` | `5000` | First retry wait (doubles each time) |
| `FINALIZE_TIMEOUT_MS` | `60000` | Max time for the finalize transaction |
| `FINALIZE_SWEEP_EVERY_MS` | `60000` | How often the `sweep` runs |
| `FINALIZE_SWEEP_BATCH_SIZE` | `100` | Tournaments per `sweep` |
| `LEADERBOARD_TTL_AFTER_END_SECONDS` | `604800` | Keep Redis keys 7 days after `endsAt` |

---

## Assumptions and tradeoffs

- A bet counts when `startsAt <= createdAt <= endsAt`, in the tournament's currency (default `USD`).
- `externalBetId` is globally unique. Bets that arrive after finalization don't change the results.
- **Postgres first, then Redis.** If Redis fails in between, the live board misses that bet until the client retries.
  Final results are always right, because they come from Postgres.
- **If Redis loses its data,** the live board isn't rebuilt; the final results are still correct.
- **BullMQ instead of RabbitMQ:** it runs on the Redis we already have, so there's no extra server to run.
- Out of scope: auth, rate limiting, listing or editing tournaments.

---

## In a bigger project

- **Outbox:** in the bet transaction, also save a row "apply this to Redis"; a background job applies it, so Redis
  catches up even if the client never retries.
- **Rebuild a lost leaderboard** from `tournament_bets`.
- **Shorter finalization lock:** mark the tournament closed first, then compute the results.
- **Higher volume:** batch bet inserts, or put a queue in front of bet ingestion.
- **Reliable Redis:** persistence and replicas.
- **Monitoring:** alerts on failed jobs, late finalization and a stopped worker; health endpoints.
