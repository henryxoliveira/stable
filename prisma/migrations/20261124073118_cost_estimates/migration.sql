-- CreateTable
CREATE TABLE "cost_estimates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "people" INTEGER NOT NULL,
    "rent_cents" INTEGER NOT NULL,
    "utilities_cents" INTEGER NOT NULL,
    "parking_cents" INTEGER NOT NULL,
    "lease_months" INTEGER NOT NULL DEFAULT 12,
    "on_campus_quarterly_cents" INTEGER,
    "quarters" INTEGER NOT NULL DEFAULT 3,
    "group_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_estimates_user_id_created_at_idx" ON "cost_estimates"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "roommate_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-added (before this migration was ever applied): database-level guards.
-- zod and the service already enforce these; the database refuses bad rows even
-- if some future code path skips validation. Prisma's schema can't express CHECKs,
-- and Prisma ignores them when diffing, so they won't cause schema drift.
ALTER TABLE "cost_estimates"
  ADD CONSTRAINT "cost_estimates_people_check" CHECK ("people" BETWEEN 1 AND 16),
  ADD CONSTRAINT "cost_estimates_rent_cents_check" CHECK ("rent_cents" >= 0),
  ADD CONSTRAINT "cost_estimates_utilities_cents_check" CHECK ("utilities_cents" >= 0),
  ADD CONSTRAINT "cost_estimates_parking_cents_check" CHECK ("parking_cents" >= 0),
  ADD CONSTRAINT "cost_estimates_on_campus_quarterly_cents_check"
    CHECK ("on_campus_quarterly_cents" IS NULL OR "on_campus_quarterly_cents" >= 0),
  ADD CONSTRAINT "cost_estimates_lease_months_check" CHECK ("lease_months" BETWEEN 1 AND 24),
  ADD CONSTRAINT "cost_estimates_quarters_check" CHECK ("quarters" BETWEEN 1 AND 4);
