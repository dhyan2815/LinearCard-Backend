-- Phase 8 — PassKit project model: program-scoped views and self-serve signup.
-- Apply with: supabase db push
--
-- Covers:
--   8.1  AuditLog.programId          (program-scoped analytics + event feed)
--   8.2  Pass.installedAt            ("Installed" count, set by the wallet callback)
--   8.3  Program.welcomeMessage / retentionDays  (program Settings tab)
--   8.4  WebhookEndpoint.programId   (program-scoped hooks; NULL = tenant-wide)
--   8.5  Idempotent orphan re-attach (safety net; Phase 3 already did the bulk)

-- 8.1 — a real column, not a details->>'passId' lookup. Every per-program read
-- would otherwise have to reach through JSONB into Pass to find the program.
ALTER TABLE "AuditLog"
  ADD COLUMN IF NOT EXISTS "programId" UUID
    REFERENCES "Program"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "AuditLog_tenant_program_action_idx"
  ON "AuditLog" ("tenantId", "programId", "action", "createdAt" DESC);

-- 8.2 — install history starts here. The wallet 'save' callback previously
-- persisted nothing, so there is no past to backfill and guessing from
-- createdAt would fabricate data.
ALTER TABLE "Pass"
  ADD COLUMN IF NOT EXISTS "installedAt" TIMESTAMPTZ;

-- 8.3
ALTER TABLE "Program"
  ADD COLUMN IF NOT EXISTS "welcomeMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "retentionDays" INTEGER;

-- 8.4 — NULL means tenant-wide, which is what every existing row is.
ALTER TABLE "WebhookEndpoint"
  ADD COLUMN IF NOT EXISTS "programId" UUID
    REFERENCES "Program"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "WebhookEndpoint_programId_idx"
  ON "WebhookEndpoint" ("programId");

-- ---------------------------------------------------------------------------
-- 8.5 Safety net. Phase 3 attached every orphan; this catches anything created
-- between that migration and this one. On an already-migrated database every
-- statement below matches zero rows.
-- ---------------------------------------------------------------------------

-- linearcard_slugify() is defined by the Phase 3 migration.
INSERT INTO "Program" ("tenantId", "name", "kind", "archetype", "status", "enrollmentSlug")
SELECT
  t."id",
  COALESCE(t."name", 'Default'),
  'loyalty',
  'loyalty',
  'published',
  linearcard_slugify(COALESCE(t."name", t."classSuffix"))
FROM "Tenant" t
WHERE NOT EXISTS (SELECT 1 FROM "Program" p WHERE p."tenantId" = t."id");

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

-- Give historic audit rows a program where their pass still resolves one, so
-- the event feed is not empty on day one. Unresolvable rows keep NULL.
UPDATE "AuditLog" a
SET "programId" = p."programId"
FROM "Pass" p
WHERE a."programId" IS NULL
  AND p."id"::text = a."details"->>'passId'
  AND p."programId" IS NOT NULL;
