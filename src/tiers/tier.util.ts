import type { Tier } from '../types';

/**
 * Pure function: given a balance and a program's real `Tier` rows, returns
 * the matching tier row (or null when no tiers are configured). Ranking is
 * by `minPoints` — the highest tier whose `minPoints` the balance meets or
 * exceeds wins. `sortOrder` is preserved on the row for callers/UI that need
 * display order, but ranking itself always goes by `minPoints`.
 */
export function computeTier(balance: number, tiers: Tier[]): Tier | null {
  if (!tiers || tiers.length === 0) {
    return null;
  }

  const sorted = [...tiers].sort(
    (a, b) => Number(a.minPoints) - Number(b.minPoints),
  );

  let matched = sorted[0];
  for (const tier of sorted) {
    if (Number(balance) >= Number(tier.minPoints)) {
      matched = tier;
    }
  }
  return matched;
}
