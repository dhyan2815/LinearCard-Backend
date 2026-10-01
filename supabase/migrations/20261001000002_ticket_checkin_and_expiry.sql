-- GAP-7 — `validate-pass` wrote nothing: an event ticket scanned ten times
-- read valid ten times, with no check-in record and no used-state.
--
-- GAP-14 (partial) — nothing enforced a dated pass's expiry. This closes the
-- one case with an actual structured date already on the row: an event
-- ticket past its own Program.eventEndsAt/eventStartsAt. Membership/student
-- expiry (`membership_expires`, `valid_until`) are still free-text template
-- strings with no backing date column, so they remain open — see GAP-14 in
-- the gap register.

ALTER TABLE "Pass"
  ADD COLUMN IF NOT EXISTS "usedAt" TIMESTAMPTZ NULL;
