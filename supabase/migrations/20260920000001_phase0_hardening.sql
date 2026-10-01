-- Phase 0 — Stop the Bleeding.
-- Apply with: supabase db push
--
-- Covers:
--   0.2  PassTemplate.googleClassIds  (ENV-1: per-environment class ids)
--   0.3  OtpSession.attempts          (SEC-4: OTP verify attempt limiting)
--   0.4  Member(tenantId, phone)      (DB-3/AUTH-1: no duplicate enrollment)

-- 0.2 — one column per environment instead of "whichever env published last".
ALTER TABLE "PassTemplate"
  ADD COLUMN IF NOT EXISTS "googleClassIds" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Existing rows published from production keep their class under the "prod" key.
UPDATE "PassTemplate"
SET "googleClassIds" = jsonb_build_object('prod', "googleClassId")
WHERE "googleClassId" IS NOT NULL
  AND "googleClassIds" = '{}'::jsonb;

-- 0.3 — count wrong OTP guesses. Sending was rate-limited; verifying was not.
ALTER TABLE "OtpSession"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

-- 0.4 — dedupe before the unique index, keeping the OLDEST member per
-- (tenantId, phone) and repointing that phone's passes and logs at it.
-- Repoint every table that references Member.id (Pass, AuditLog, ConsentLog,
-- NotificationLog, …) at the surviving row, so nothing is orphaned or
-- cascade-deleted along with the duplicate.
DO $$
DECLARE
  ref RECORD;
BEGIN
  FOR ref IN
    SELECT c.conrelid::regclass AS tbl,
           a.attname            AS col
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = '"Member"'::regclass
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format(
      'WITH ranked AS (
         SELECT id, FIRST_VALUE(id) OVER (
           PARTITION BY "tenantId", phone ORDER BY "createdAt") AS keep_id
         FROM "Member"
       ), dupes AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
       UPDATE %s t SET %I = d.keep_id FROM dupes d WHERE t.%I = d.id',
      ref.tbl, ref.col, ref.col
    );
  END LOOP;
END $$;

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY "tenantId", phone ORDER BY "createdAt"
         ) AS keep_id
  FROM "Member"
),
dupes AS (
  SELECT id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM "Member" m
USING dupes d
WHERE m.id = d.id;

CREATE UNIQUE INDEX IF NOT EXISTS "Member_tenantId_phone_key"
  ON "Member" ("tenantId", phone);
