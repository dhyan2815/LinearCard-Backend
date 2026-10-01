-- Phase 3 — Program → Tier → Template migration.
-- Apply with: supabase db push
--
-- Covers:
--   3.1  Drop Program_tenantId_unique (DB-4, D8)
--        PassTemplate.programId       (DB-5)
--        Program.kind + program-owned config columns (D9/D14)
--        Pass.programId FK            (column itself landed in Phase 2)
--        Drop PassTemplate.tierThresholds (D11 — no coexistence window)
--   3.7  Class suffixes derive from tenant/program/tier slugs (DB-6)

-- 3.1 — D8: one tenant runs several programs. The unique index was the only
-- thing making "the tenant's program" a meaningful phrase; every code path
-- that relied on it is rewritten in this phase.
DROP INDEX IF EXISTS "Program_tenantId_unique";
ALTER TABLE "Program" DROP CONSTRAINT IF EXISTS "Program_tenantId_unique";
ALTER TABLE "Program" DROP CONSTRAINT IF EXISTS "Program_tenantId_key";
CREATE INDEX IF NOT EXISTS "Program_tenantId_idx" ON "Program" ("tenantId");

-- `kind` is the D9/D14 discriminator. Ticket programs have no points and no
-- tiers, so the loyalty columns stay NULL for them and the designer hides
-- the tier editor entirely.
ALTER TABLE "Program"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'loyalty',
  ADD COLUMN IF NOT EXISTS "archetype" TEXT NOT NULL DEFAULT 'loyalty',
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "enrollmentSlug" TEXT,
  -- loyalty-only economics; they move here off PassTemplate (Phase 1.3's
  -- interim home). The template columns stay for back-compat reads.
  ADD COLUMN IF NOT EXISTS "earnRate" NUMERIC,
  ADD COLUMN IF NOT EXISTS "redeemRate" NUMERIC,
  ADD COLUMN IF NOT EXISTS "redeemCapPercent" INTEGER,
  -- ticket-only
  ADD COLUMN IF NOT EXISTS "eventStartsAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "eventEndsAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "venueName" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "Program" DROP CONSTRAINT IF EXISTS "Program_kind_check";
ALTER TABLE "Program"
  ADD CONSTRAINT "Program_kind_check" CHECK ("kind" IN ('loyalty', 'ticket'));

ALTER TABLE "Program" DROP CONSTRAINT IF EXISTS "Program_status_check";
ALTER TABLE "Program"
  ADD CONSTRAINT "Program_status_check"
  CHECK ("status" IN ('draft', 'published', 'archived'));

-- The enrollment URL is /enroll/:tenantSlug/:programSlug, so the slug only
-- has to be unique inside a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "Program_tenantId_enrollmentSlug_unique"
  ON "Program" ("tenantId", "enrollmentSlug")
  WHERE "enrollmentSlug" IS NOT NULL;

-- 3.1 — DB-5. A template belongs to exactly one program; a program's tiers
-- each point at their own template (Tier.templateId), which is what makes
-- the tier-driven design swap work.
ALTER TABLE "PassTemplate"
  ADD COLUMN IF NOT EXISTS "programId" UUID
    REFERENCES "Program"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "PassTemplate_programId_idx"
  ON "PassTemplate" ("programId");

-- Pass.programId arrived in Phase 2 (for campaign segmentation) without a
-- foreign key because nothing populated it yet. It does now.
ALTER TABLE "Pass" DROP CONSTRAINT IF EXISTS "Pass_programId_fkey";
ALTER TABLE "Pass"
  ADD CONSTRAINT "Pass_programId_fkey"
  FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Backfill. One loyalty Program per existing tenant, built from that tenant's
-- published template (falling back to any template), with every one of that
-- tenant's templates and passes attached to it. Runs before the
-- tierThresholds drop so the legacy JSONB can seed real Tier rows.
-- ---------------------------------------------------------------------------

-- A slug safe for both a URL and a Google Wallet class id.
CREATE OR REPLACE FUNCTION linearcard_slugify(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(trim(both '_' from regexp_replace(lower(COALESCE(p_text, '')), '[^a-z0-9]+', '_', 'g')), ''),
    'program'
  );
$$;

INSERT INTO "Program" ("tenantId", "name", "kind", "archetype", "status", "enrollmentSlug")
SELECT
  t."id",
  COALESCE(t."name", 'Loyalty') || ' Loyalty',
  'loyalty',
  'loyalty',
  'published',
  linearcard_slugify(COALESCE(t."name", t."classSuffix"))
FROM "Tenant" t
WHERE NOT EXISTS (SELECT 1 FROM "Program" p WHERE p."tenantId" = t."id");

-- Pre-existing Program rows (created before this migration) have no slug.
UPDATE "Program" p
SET "enrollmentSlug" = linearcard_slugify(p."name")
WHERE p."enrollmentSlug" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Program" q
    WHERE q."tenantId" = p."tenantId"
      AND q."enrollmentSlug" = linearcard_slugify(p."name")
  );

-- Attach every unattached template and pass to its tenant's oldest program.
-- "Oldest" is correct exactly here: before this migration a tenant could only
-- have one program, so there is no ambiguity to resolve.
WITH canonical AS (
  SELECT DISTINCT ON ("tenantId") "tenantId", "id"
  FROM "Program"
  ORDER BY "tenantId", "createdAt" ASC
)
UPDATE "PassTemplate" pt
SET "programId" = c."id"
FROM canonical c
WHERE pt."tenantId" = c."tenantId" AND pt."programId" IS NULL;

WITH canonical AS (
  SELECT DISTINCT ON ("tenantId") "tenantId", "id"
  FROM "Program"
  ORDER BY "tenantId", "createdAt" ASC
)
UPDATE "Pass" p
SET "programId" = c."id"
FROM canonical c
WHERE p."tenantId" = c."tenantId" AND p."programId" IS NULL;

-- Carry the interim loyalty economics (Phase 1.3) up onto the program, from
-- the template the runtime would have scored against.
WITH src AS (
  SELECT DISTINCT ON (pt."programId")
    pt."programId", pt."earnRate", pt."redeemRate", pt."redeemCapPercent"
  FROM "PassTemplate" pt
  WHERE pt."programId" IS NOT NULL
  ORDER BY pt."programId", (pt."status" = 'published') DESC, pt."updatedAt" DESC
)
UPDATE "Program" p
SET "earnRate" = src."earnRate",
    "redeemRate" = src."redeemRate",
    "redeemCapPercent" = src."redeemCapPercent"
FROM src
WHERE p."id" = src."programId" AND p."earnRate" IS NULL;

-- 3.2 — seed real Tier rows from the legacy JSONB for any program that has
-- none, so an existing tenant's tiers survive the drop below.
WITH legacy AS (
  SELECT DISTINCT ON (pt."programId")
    pt."programId", pt."id" AS "templateId", pt."tierThresholds"
  FROM "PassTemplate" pt
  WHERE pt."programId" IS NOT NULL
    AND jsonb_typeof(pt."tierThresholds") = 'array'
    AND jsonb_array_length(pt."tierThresholds") > 0
  ORDER BY pt."programId", (pt."status" = 'published') DESC, pt."updatedAt" DESC
)
INSERT INTO "Tier" ("programId", "name", "minPoints", "templateId", "sortOrder")
SELECT
  l."programId",
  e.value->>'name',
  COALESCE((e.value->>'min')::INTEGER, 0),
  l."templateId",
  e.ordinality - 1
FROM legacy l
CROSS JOIN LATERAL jsonb_array_elements(l."tierThresholds") WITH ORDINALITY AS e(value, ordinality)
WHERE NOT EXISTS (SELECT 1 FROM "Tier" t WHERE t."programId" = l."programId");

-- 3.1 / D11 — the designer wrote this JSONB and the runtime ignored it
-- (DB-9). `Tier` rows are now the only tier source of truth.
ALTER TABLE "PassTemplate" DROP COLUMN IF EXISTS "tierThresholds";
