-- AlterEnum
ALTER TYPE "TournamentStatus" ADD VALUE 'CLOSING';

-- CreateTable
CREATE TABLE "leaderboard_outbox" (
    "tournament_id" UUID NOT NULL,
    "bet_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_outbox_pkey" PRIMARY KEY ("tournament_id","bet_id")
);

-- CreateIndex
CREATE INDEX "leaderboard_outbox_created_at_idx" ON "leaderboard_outbox"("created_at");

-- AddForeignKey
ALTER TABLE "leaderboard_outbox" ADD CONSTRAINT "leaderboard_outbox_tournament_id_bet_id_fkey" FOREIGN KEY ("tournament_id", "bet_id") REFERENCES "tournament_bets"("tournament_id", "bet_id") ON DELETE CASCADE ON UPDATE CASCADE;
