import { describe, it, expect } from 'vitest';
import { computeAdjustment } from '../../lib/calc/adjust.js';
import type { AdjustmentInput } from '../../lib/calc/adjust.js';

const base: AdjustmentInput = {
  currentTargetKcal: 2500,
  targetRateKgPerWeek: 0.5,
  observedRateKgPerWeek: 0.5,
  kcalFloor: 2100,
  isBaselineLocked: false,
  lastAdjustmentDate: null,
  today: '2026-09-09',
  sleepBlocksDownwardAdjustment: false,
};

describe('computeAdjustment', () => {
  it('never changes anything while the baseline is locked', () => {
    const result = computeAdjustment({ ...base, isBaselineLocked: true, observedRateKgPerWeek: 0.9 });
    expect(result).toEqual({ newTargetKcal: 2500, changed: false, reason: 'baseline locked' });
  });

  it('refuses a second adjustment within the same 7-day window', () => {
    const result = computeAdjustment({
      ...base,
      observedRateKgPerWeek: 0.9,
      lastAdjustmentDate: '2026-09-05',
      today: '2026-09-09',
    });
    expect(result).toEqual({ newTargetKcal: 2500, changed: false, reason: 'already adjusted this week' });
  });

  it('allows adjustment once 7 days have passed since the last one', () => {
    const result = computeAdjustment({
      ...base,
      observedRateKgPerWeek: 0.9,
      lastAdjustmentDate: '2026-09-01',
      today: '2026-09-09',
    });
    expect(result.changed).toBe(true);
  });

  it('makes no change when observed rate is within 20% of target', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.51 });
    expect(result).toEqual({ newTargetKcal: 2500, changed: false, reason: 'within tolerance' });
  });

  it('decreases the target by up to 100 kcal when losing too slowly', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.3 });
    expect(result).toEqual({ newTargetKcal: 2400, changed: true, reason: 'too slow' });
  });

  it('never decreases below the kcal floor', () => {
    const result = computeAdjustment({ ...base, currentTargetKcal: 2150, observedRateKgPerWeek: 0.3 });
    expect(result).toEqual({ newTargetKcal: 2100, changed: true, reason: 'too slow' });
  });

  it('increases the target when losing too fast', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.9 });
    expect(result).toEqual({ newTargetKcal: 2600, changed: true, reason: 'too fast' });
  });

  it('blocks a downward adjustment when two bad nights were logged, even if losing too slowly', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.3, sleepBlocksDownwardAdjustment: true });
    expect(result).toEqual({ newTargetKcal: 2500, changed: false, reason: 'sleep blocks downward adjustment' });
  });

  it('does not block an upward adjustment, even with two bad nights logged', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.9, sleepBlocksDownwardAdjustment: true });
    expect(result).toEqual({ newTargetKcal: 2600, changed: true, reason: 'too fast' });
  });
});
