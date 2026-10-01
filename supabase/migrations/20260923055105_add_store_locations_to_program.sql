-- Add storeLocations to Program
ALTER TABLE "Program" ADD COLUMN "storeLocations" jsonb DEFAULT '[]'::jsonb;

-- Backfill from PassTemplate
-- For each program, we pick the storeLocations from one of its templates that has non-empty storeLocations, preferably the latest updated one.
WITH RankedTemplates AS (
    SELECT 
        "programId", 
        "storeLocations",
        ROW_NUMBER() OVER (PARTITION BY "programId" ORDER BY "updatedAt" DESC) as rn
    FROM "PassTemplate"
    WHERE "storeLocations" IS NOT NULL AND jsonb_array_length("storeLocations") > 0
)
UPDATE "Program" p
SET "storeLocations" = rt."storeLocations"
FROM RankedTemplates rt
WHERE p."id" = rt."programId" AND rt.rn = 1;
