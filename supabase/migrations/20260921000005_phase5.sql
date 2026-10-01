-- Phase 5 — Payment-triggered enrollment.
-- Apply with: supabase db push
--
-- Covers:
--   5.1  Per-tenant payment webhook secret (HMAC-SHA256)
--        PaymentEvent — replay protection (nonce) + the audit trail
--   5.2  No schema change: enrollment reuses Member/Pass as they are

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "paymentWebhookSecret" TEXT;

-- The stored shape is the *normalized* payment, and that is the whole
-- privacy boundary: phone, amount, merchant reference, time. No PAN, no
-- VPA, no card token — a PSP payload carrying them is dropped at
-- normalizePayment() and never reaches this table.
CREATE TABLE IF NOT EXISTS "PaymentEvent" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "provider"    TEXT NOT NULL DEFAULT 'mock',
  "nonce"       TEXT NOT NULL,
  "phone"       TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency"    TEXT NOT NULL DEFAULT 'INR',
  "merchantRef" TEXT,
  "occurredAt"  TIMESTAMPTZ,
  "passId"      UUID REFERENCES "Pass"("id") ON DELETE SET NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This index *is* the replay check: a second delivery of the same signed
-- payload fails the insert instead of awarding points twice.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_tenantId_nonce_unique"
  ON "PaymentEvent" ("tenantId", "nonce");

CREATE INDEX IF NOT EXISTS "PaymentEvent_tenantId_createdAt_idx"
  ON "PaymentEvent" ("tenantId", "createdAt" DESC);
