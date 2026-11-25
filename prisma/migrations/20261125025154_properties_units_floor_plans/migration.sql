-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('AVAILABLE', 'LEASED');

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CA',
    "postal_code" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "bedrooms" INTEGER NOT NULL,
    "beds" INTEGER NOT NULL,
    "bathrooms" DOUBLE PRECISION NOT NULL,
    "square_feet" INTEGER,
    "rent_cents" INTEGER NOT NULL,
    "utilities_cents" INTEGER NOT NULL DEFAULT 0,
    "parking_cents" INTEGER NOT NULL DEFAULT 0,
    "status" "UnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floor_plans" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "square_feet" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "floor_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "properties_owner_id_idx" ON "properties"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "units_property_id_label_key" ON "units"("property_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "floor_plans_unit_id_name_key" ON "floor_plans"("unit_id", "name");

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_plans" ADD CONSTRAINT "floor_plans_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added (before this migration was ever applied): database-level guards.
-- zod already enforces these; the database refuses bad rows even if a future
-- code path skips validation. Prisma can't express CHECKs and ignores them
-- when diffing, so they don't cause schema drift.
ALTER TABLE "properties"
  ADD CONSTRAINT "properties_latitude_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "properties_longitude_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "properties_lat_lng_together_check" CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

ALTER TABLE "units"
  ADD CONSTRAINT "units_bedrooms_check" CHECK ("bedrooms" BETWEEN 0 AND 20),
  ADD CONSTRAINT "units_beds_check" CHECK ("beds" BETWEEN 1 AND 16),
  ADD CONSTRAINT "units_bathrooms_check" CHECK ("bathrooms" BETWEEN 0 AND 10),
  ADD CONSTRAINT "units_square_feet_check" CHECK ("square_feet" IS NULL OR "square_feet" > 0),
  ADD CONSTRAINT "units_rent_cents_check" CHECK ("rent_cents" >= 0),
  ADD CONSTRAINT "units_utilities_cents_check" CHECK ("utilities_cents" >= 0),
  ADD CONSTRAINT "units_parking_cents_check" CHECK ("parking_cents" >= 0);

ALTER TABLE "floor_plans"
  ADD CONSTRAINT "floor_plans_square_feet_check" CHECK ("square_feet" IS NULL OR "square_feet" > 0);
