-- Add whatsappTemplates to Program
ALTER TABLE "Program" ADD COLUMN "whatsappTemplates" jsonb DEFAULT '{}'::jsonb;

-- Drop the unique constraint for phone per tenant on Member
-- The exact constraint name might vary, but based on previous output it is "Member_tenantId_phone_key"
ALTER TABLE "Member" DROP CONSTRAINT IF EXISTS "Member_tenantId_phone_key";
DROP INDEX IF EXISTS "Member_tenantId_phone_key";
