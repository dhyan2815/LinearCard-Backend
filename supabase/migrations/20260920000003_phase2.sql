-- Phase 2 — Campaigns As A Real Feature.
-- Apply with: supabase db push
--
-- Covers:
--   2.1  Campaign table + NotificationLog.campaignId   (DB-7)
--   2.4  Member.marketingOptOutAt                      (DB-8)
--
-- Scheduling is deliberately absent (D10 — send-now only), so there is no
-- `scheduledFor` column and no job-runner state machine.

CREATE TABLE IF NOT EXISTS "Campaign" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"       UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  -- Nullable until Phase 3 attaches programs to passes; the audience filter
  -- already carries programId so this becomes meaningful with no code change.
  "programId"      UUID,
  "name"           TEXT NOT NULL,
  "channel"        TEXT NOT NULL CHECK ("channel" IN ('whatsapp', 'wallet_push')),
  "header"         TEXT,
  "body"           TEXT NOT NULL,
  "audienceFilter" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status"         TEXT NOT NULL DEFAULT 'draft'
                     CHECK ("status" IN ('draft', 'sending', 'sent', 'failed')),
  "sentAt"         TIMESTAMPTZ,
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "sentCount"      INTEGER NOT NULL DEFAULT 0,
  "failedCount"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "Campaign_tenantId_createdAt_idx"
  ON "Campaign" ("tenantId", "createdAt" DESC);

-- Per-recipient NotificationLog rows roll up into their campaign, which is
-- what turns a campaign into something reportable and re-sendable instead of
-- a loose scatter of rows tagged type='campaign'.
ALTER TABLE "NotificationLog"
  ADD COLUMN IF NOT EXISTS "campaignId" UUID
    REFERENCES "Campaign"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "NotificationLog_campaignId_idx"
  ON "NotificationLog" ("campaignId");

-- 2.2 — program-scoped segmentation (D8) reads `Pass.programId`. Phase 3.1
-- owns this column and adds it idempotently; pulling it forward here is what
-- makes "Gold members of Coffee Loyalty" a real filter today instead of a
-- field the API accepts and silently ignores. Nothing populates it until
-- Phase 3, so an unset programId filter simply never narrows.
ALTER TABLE "Pass"
  ADD COLUMN IF NOT EXISTS "programId" UUID;

CREATE INDEX IF NOT EXISTS "Pass_programId_idx" ON "Pass" ("programId");

-- 2.4 — DPDP requires withdrawal to be as easy as granting. ConsentLog only
-- ever recorded grants; this is the revocation side, and every campaign send
-- filters on it.
ALTER TABLE "Member"
  ADD COLUMN IF NOT EXISTS "marketingOptOutAt" TIMESTAMPTZ;
