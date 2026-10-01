-- Business categories & native Google Wallet pass types — Phase 1 schema.
-- See plans/BUSINESS_CATEGORY_WALLET_TYPES_PLAN.md.
--
-- Tenant.businessCategory decides which presets a tenant may create. NULL is
-- a legacy tenant that has not picked one yet (unrestricted).
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "businessCategory" TEXT NULL;

ALTER TABLE "Tenant" DROP CONSTRAINT IF EXISTS "Tenant_businessCategory_check";
ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_businessCategory_check" CHECK (
    "businessCategory" IS NULL OR "businessCategory" IN (
      'retail', 'food_beverage', 'salon_spa_fitness', 'events_entertainment',
      'travel', 'education', 'professional_services', 'test'
    )
  );

-- Program.walletType is fixed at creation: Google requires an object's class
-- to be the same type, so an issued pass can never change type. Every
-- existing program stays 'generic' via the default (D1).
ALTER TABLE "Program"
  ADD COLUMN IF NOT EXISTS "walletType" TEXT NOT NULL DEFAULT 'generic';

ALTER TABLE "Program" DROP CONSTRAINT IF EXISTS "Program_walletType_check";
ALTER TABLE "Program"
  ADD CONSTRAINT "Program_walletType_check" CHECK (
    "walletType" IN ('generic', 'loyalty', 'giftCard', 'offer', 'eventTicket')
  );

-- Widen the kind discriminator. Existing rows keep their kind.
ALTER TABLE "Program" DROP CONSTRAINT IF EXISTS "Program_kind_check";
ALTER TABLE "Program"
  ADD CONSTRAINT "Program_kind_check" CHECK (
    "kind" IN ('loyalty', 'ticket', 'giftcard', 'coupon', 'studentid')
  );
