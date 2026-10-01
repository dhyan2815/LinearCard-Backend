-- Phase 7 — Production hardening.
-- Apply with: supabase db push
--
-- Covers:
--   7.1  IdempotencyRecord — replay-safe mutating endpoints (PRD §8)
--   7.3  RLS policies on every tenant-scoped table + a non-service-role
--        read path keyed to a `tenant_id` JWT claim
--   7.4  Job — durable queue for campaign sends and pass resyncs
--   7.6  Member."erasedAt" — DPDP erasure tombstone

-- ────────────────────────────────────────────────────────────────────────
-- 7.1  Idempotency
-- ────────────────────────────────────────────────────────────────────────
-- The unique index IS the lock: the first request to insert its key wins and
-- goes on to do the work; a replay collides, reads the stored response and
-- replays it verbatim. No advisory locks, no Redis.
CREATE TABLE IF NOT EXISTS "IdempotencyRecord" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"   UUID REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "key"        TEXT NOT NULL,
  "method"     TEXT NOT NULL,
  "path"       TEXT NOT NULL,
  -- SHA-256 of the request body. A same-key-different-body request is a
  -- client bug, and must be rejected rather than served a stale response.
  "bodyHash"   TEXT NOT NULL,
  "status"     INTEGER,
  "response"   JSONB,
  "completedAt" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyRecord_scope_key"
  ON "IdempotencyRecord" ("key", "method", "path");

CREATE INDEX IF NOT EXISTS "IdempotencyRecord_createdAt_idx"
  ON "IdempotencyRecord" ("createdAt");

-- ────────────────────────────────────────────────────────────────────────
-- 7.4  Job queue
-- ────────────────────────────────────────────────────────────────────────
-- Postgres-backed, polled in-process. Survives a restart, which is the whole
-- point: a campaign send that died mid-dispatch is picked up again instead
-- of vanishing with the process that owned it.
CREATE TABLE IF NOT EXISTS "Job" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "kind"        TEXT NOT NULL,
  "payload"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status"      TEXT NOT NULL DEFAULT 'queued',
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "result"      JSONB,
  "error"       TEXT,
  "lockedAt"    TIMESTAMPTZ,
  "startedAt"   TIMESTAMPTZ,
  "finishedAt"  TIMESTAMPTZ,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "Job_claim_idx"
  ON "Job" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Job_tenant_idx"
  ON "Job" ("tenantId", "createdAt" DESC);

-- Claims one queued job atomically. Without SKIP LOCKED two API instances
-- pick the same row and send the same campaign twice.
CREATE OR REPLACE FUNCTION claim_job() RETURNS SETOF "Job" AS $$
  UPDATE "Job" SET
    "status"    = 'running',
    "attempts"  = "attempts" + 1,
    "lockedAt"  = now(),
    "startedAt" = COALESCE("startedAt", now())
  WHERE "id" = (
    SELECT "id" FROM "Job"
    WHERE "status" = 'queued'
       -- a 'running' row untouched for 5 minutes lost its owner to a restart
       OR ("status" = 'running' AND "lockedAt" < now() - INTERVAL '5 minutes')
    ORDER BY "createdAt"
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────────────────
-- 7.6  DPDP erasure
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE "Member"
  ADD COLUMN IF NOT EXISTS "erasedAt" TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────────────────
-- 7.3  Row-Level Security
-- ────────────────────────────────────────────────────────────────────────
-- Until now CLAUDE.md claimed RLS existed and it did not (DB-2). Tenant
-- isolation was application-code-only: one query missing its .eq('tenantId')
-- returned every tenant's rows.
--
-- Deliberately NOT `FORCE ROW LEVEL SECURITY`. The backend connects as
-- `service_role`, which is BYPASSRLS; forcing would lock the application
-- out of its own database. RLS here is the second line of defence, and the
-- guarantee behind the `authenticated` read path the API now uses for
-- tenant-scoped reads (SupabaseService.forTenant).
--
-- Every table carrying a "tenantId" gets the same policy, discovered from
-- the catalog rather than hardcoded — so a table added later is covered by
-- re-running this block, and a table renamed does not silently lose its
-- policy while the migration still reports success.
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenantId'
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.table_name);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        FOR ALL TO authenticated
        USING ("tenantId"::text = (auth.jwt() ->> 'tenant_id'))
        WITH CHECK ("tenantId"::text = (auth.jwt() ->> 'tenant_id'))
    $p$, t.table_name);
  END LOOP;
END $$;

-- Tenant itself is keyed by "id", not "tenantId": a tenant reads its own row
-- and no other.
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON "Tenant";
CREATE POLICY tenant_self ON "Tenant"
  FOR ALL TO authenticated
  USING ("id"::text = (auth.jwt() ->> 'tenant_id'))
  WITH CHECK ("id"::text = (auth.jwt() ->> 'tenant_id'));

-- Tables with no tenant column at all hold no tenant data that an
-- `authenticated` caller may read. RLS on with no policy = deny-all, which
-- is the correct default for them.
ALTER TABLE "Admin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OtpSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
