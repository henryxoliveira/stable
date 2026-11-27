-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPLICATION_SUBMITTED', 'DOCUMENTS_REQUESTED', 'REVIEW_STARTED', 'OFFER_MADE', 'OFFER_RESCINDED', 'APPLICATION_REJECTED', 'DOCUMENTS_SENT', 'APPLICATION_WITHDRAWN', 'OFFER_DECLINED', 'OFFER_ACCEPTED', 'APPLICATION_CLOSED', 'OFFER_EXPIRED', 'GROUP_INVITE');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Added by hand (Prisma can't express CHECKs and ignores them): a notification's
-- link must be an internal path. It starts with exactly one "/" (never "//" or
-- "/\", which browsers treat as another site) and has no spaces or control
-- characters. notification.service.js checks the same rule before writing.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_link_internal_check"
  CHECK ("link" ~ '^/([^/\\]|$)' AND "link" !~ '[[:space:][:cntrl:]]');
