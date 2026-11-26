-- CreateTable
CREATE TABLE "lease_summaries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "flagged_clauses" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lease_summaries_user_id_created_at_idx" ON "lease_summaries"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "lease_summaries" ADD CONSTRAINT "lease_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
