-- CreateEnum
CREATE TYPE "AccountEventType" AS ENUM ('LANDLORD_APPROVED', 'LANDLORD_REJECTED', 'PROMOTED_TO_ADMIN');

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'REJECTED';

-- CreateTable
CREATE TABLE "account_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "type" "AccountEventType" NOT NULL,
    "comment" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_events_target_user_id_created_at_idx" ON "account_events"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX "account_events_created_at_idx" ON "account_events"("created_at");

-- AddForeignKey
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
