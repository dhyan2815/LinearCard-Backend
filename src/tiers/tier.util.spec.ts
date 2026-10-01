import type { Tier } from '../types';
import { computeTier } from './tier.util';

describe('computeTier', () => {
  const tier = (name: string, minPoints: number, sortOrder: number): Tier => ({
    id: `tier-${name.toLowerCase()}`,
    programId: 'program-1',
    name,
    minPoints,
    templateId: `template-${name.toLowerCase()}`,
    sortOrder,
  });

  const tiers = [
    tier('Bronze', 0, 0),
    tier('Silver', 500, 1),
    tier('Gold', 2000, 2),
  ];

  it('returns the lowest tier for a balance below every threshold', () => {
    expect(computeTier(-5, tiers)?.name).toBe('Bronze');
  });

  it('returns the matching tier at an exact threshold boundary', () => {
    expect(computeTier(500, tiers)?.name).toBe('Silver');
  });

  it('returns the highest matching tier for a balance between two thresholds', () => {
    expect(computeTier(1999, tiers)?.name).toBe('Silver');
  });

  it('returns the top tier for a balance above every threshold', () => {
    expect(computeTier(50000, tiers)?.name).toBe('Gold');
  });

  it('sorts unordered tiers before computing', () => {
    const unordered = [
      tier('Gold', 2000, 2),
      tier('Bronze', 0, 0),
      tier('Silver', 500, 1),
    ];
    expect(computeTier(600, unordered)?.name).toBe('Silver');
  });

  it('returns null when no tiers are configured', () => {
    expect(computeTier(1000, [])).toBeNull();
  });

  it('carries the templateId of the matched tier (payoff for design swap)', () => {
    expect(computeTier(600, tiers)?.templateId).toBe('template-silver');
  });
});
