-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('OPEN', 'FINALIZED');

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'OPEN',
    "finalized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" UUID NOT NULL,
    "external_bet_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_bets" (
    "tournament_id" UUID NOT NULL,
    "bet_id" UUID NOT NULL,
    "player_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "counted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_bets_pkey" PRIMARY KEY ("tournament_id","bet_id")
);

-- CreateTable
CREATE TABLE "tournament_results" (
    "tournament_id" UUID NOT NULL,
    "player_id" TEXT NOT NULL,
    "score" BIGINT NOT NULL,
    "placement" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_results_pkey" PRIMARY KEY ("tournament_id","player_id")
);

-- CreateIndex
CREATE INDEX "tournaments_status_starts_at_ends_at_idx" ON "tournaments"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "bets_external_bet_id_key" ON "bets"("external_bet_id");

-- CreateIndex
CREATE INDEX "bets_player_id_idx" ON "bets"("player_id");

-- CreateIndex
CREATE INDEX "tournament_bets_tournament_id_player_id_idx" ON "tournament_bets"("tournament_id", "player_id");

-- CreateIndex
CREATE INDEX "tournament_results_tournament_id_placement_idx" ON "tournament_results"("tournament_id", "placement");

-- AddForeignKey
ALTER TABLE "tournament_bets" ADD CONSTRAINT "tournament_bets_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_bets" ADD CONSTRAINT "tournament_bets_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_results" ADD CONSTRAINT "tournament_results_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
