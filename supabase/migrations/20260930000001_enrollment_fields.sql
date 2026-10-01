-- Phase 6 — per-member enrollment fields.
--
-- Before this, an event ticket or a student ID showed the template's static
-- placeholder ("—") identically on every member's pass: the seat, section and
-- roll number were never captured anywhere.

-- What the program asks the member for at enrollment. NULL/[] means nothing
-- extra is collected, which is every existing program.
ALTER TABLE "Program"
  ADD COLUMN IF NOT EXISTS "enrollmentFields" JSONB NULL;

-- The answers, per pass. On Pass rather than Member because the values belong
-- to the individual card: one member can hold two tickets with two seats.
ALTER TABLE "Pass"
  ADD COLUMN IF NOT EXISTS "customAttributes" JSONB NOT NULL DEFAULT '{}'::jsonb;
