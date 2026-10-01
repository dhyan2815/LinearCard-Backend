-- GAP-13 — visit/stamp programs (gym_membership, stamp_card) relied on the
-- operator typing `amount = 1` by convention, and nothing fired at the
-- reward threshold (10 stamps, a gym tier). `visitMode` lets the scanner lock
-- the amount to 1 instead of trusting the till; `rewardThreshold` lets a
-- program without a tier ladder (stamp_card has exactly one tier) still get
-- a one-time "reward unlocked" notification without auto-redeeming it.

ALTER TABLE "Program"
  ADD COLUMN IF NOT EXISTS "visitMode" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Program"
  ADD COLUMN IF NOT EXISTS "rewardThreshold" INTEGER NULL;
