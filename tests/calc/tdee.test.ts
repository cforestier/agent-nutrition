import { describe, it, expect } from 'vitest';
import { predictedTdee, observedTdee, tdeeComparison } from '../../lib/calc/tdee.js';

describe('predictedTdee', () => {
  it('computes BMR via Katch-McArdle on measured lean mass, times activity factor, plus planned segments', () => {
    // BMR = 370 + 21.6 * 65 = 1774; base = 1774 * 1.5 = 2661; + 239 segments = 2900
    const result = predictedTdee({ leanMassKg: 65, activityFactor: 1.5, plannedSegmentsKcal: 239 });
    expect(result).toBe(2900);
  });
});

describe('observedTdee', () => {
  it('derives maintenance from intake and the resulting weight change over 14 days', () => {
    // delta = 69 - 70 = -1kg; observed = 2700 - (-1 * 7700 / 14) = 2700 + 550 = 3250
    expect(observedTdee(2700, 70, 69)).toBe(3250);
  });

  it('accepts a custom window length', () => {
    expect(observedTdee(2700, 70, 69, 7)).toBe(2700 + 1100);
  });
});

describe('tdeeComparison', () => {
  it('flags no data-quality issue when the gap is under 25%', () => {
    const result = tdeeComparison(2900, 3250);
    expect(result).toEqual({ predicted: 2900, observed: 3250, deltaPct: expect.any(Number), dataQualityFlag: false });
    expect(result.deltaPct).toBeCloseTo(12.07, 1);
  });

  it('flags a data-quality issue when the gap exceeds 25%', () => {
    const result = tdeeComparison(2000, 3000);
    expect(result.deltaPct).toBeCloseTo(50, 5);
    expect(result.dataQualityFlag).toBe(true);
  });
});
