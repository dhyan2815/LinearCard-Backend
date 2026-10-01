-- Phase 1 — One Flow, Undeniable.
-- Apply with: supabase db push
--
-- Covers:
--   1.3  PassTemplate.earnRate/redeemRate/redeemCapPercent  (WAL-4)
--   1.4  increment_pass_balance()                           (WAL-5)
--   1.5  Member.isTestAccount                               (§1.7)

-- 1.3 — loyalty economics per template. Programs own these post Phase 3; the
-- template is the interim home so two demo brands can differ today.
-- Defaults reproduce the previously hardcoded 10% earn / 1:₹1 redeem / 50% cap.
ALTER TABLE "PassTemplate"
  ADD COLUMN IF NOT EXISTS "earnRate" NUMERIC NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS "redeemRate" NUMERIC NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "redeemCapPercent" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "PassTemplate"
  DROP CONSTRAINT IF EXISTS "PassTemplate_loyalty_rules_check";
ALTER TABLE "PassTemplate"
  ADD CONSTRAINT "PassTemplate_loyalty_rules_check"
  CHECK (
    "earnRate" >= 0 AND "earnRate" <= 10
    AND "redeemRate" > 0 AND "redeemRate" <= 1000
    AND "redeemCapPercent" >= 0 AND "redeemCapPercent" <= 100
  );

-- 1.5 — the demo-mode issuance gate (passes.controller) reads this column;
-- without it the gate is operable only by direct DB edit.
ALTER TABLE "Member"
  ADD COLUMN IF NOT EXISTS "isTestAccount" BOOLEAN NOT NULL DEFAULT false;

-- 1.4 — atomic balance mutation (WAL-5). The read-modify-write in
-- processOrderTransaction loses a transaction when two scans race; this does
-- the arithmetic inside Postgres and returns the authoritative new balance.
-- Clamped at 0 so a concurrent redeem can never drive a pass negative.
CREATE OR REPLACE FUNCTION increment_pass_balance(p_pass_id UUID, p_delta INTEGER)
RETURNS INTEGER
LANGUAGE sql
AS $$
  UPDATE "Pass"
  SET balance = GREATEST(0, COALESCE(balance, 0) + p_delta)
  WHERE id = p_pass_id
  RETURNING balance;
$$;
