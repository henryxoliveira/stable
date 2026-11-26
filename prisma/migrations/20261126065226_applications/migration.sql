-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED', 'DOCS_REQUESTED', 'UNDER_REVIEW', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApplicationActor" AS ENUM ('GROUP_MEMBER', 'LISTING_OWNER', 'SYSTEM');

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "group_size" INTEGER NOT NULL,
    "offer_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_events" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" "ApplicationActor" NOT NULL,
    "from_status" "ApplicationStatus",
    "to_status" "ApplicationStatus" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "applications_unit_id_status_idx" ON "applications"("unit_id", "status");

-- CreateIndex
CREATE INDEX "applications_group_id_idx" ON "applications"("group_id");

-- CreateIndex
CREATE INDEX "application_events_application_id_created_at_idx" ON "application_events"("application_id", "created_at");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "roommate_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-added: an application can't be OFFERED without a deadline. The service already
-- sets one; the database refuses the bad row even if a future code path forgets.
-- Prisma ignores CHECK constraints when comparing schemas, so this causes no drift.
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_offer_needs_deadline_check"
  CHECK ("status" <> 'OFFERED' OR "offer_expires_at" IS NOT NULL);
