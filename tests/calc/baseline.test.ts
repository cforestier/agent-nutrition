import { describe, it, expect } from 'vitest';
import {
  kcalFloor,
  bmi,
  isBelowBmiFloor,
  proteinTargetRangeG,
  resolveGoal,
  triggerRebaseline,
  isBaselineLocked,
  isStagnating,
  needsScheduledDietBreak,
  isPerformanceDeclining,
  blocksDownwardAdjustmentFromSleep,
  RATE_MAX_PCT,
} from '../../lib/calc/baseline.js';

describe('kcalFloor', () => {
  it('uses the absolute safety net when lean-mass-derived floor is lower', () => {
    expect(kcalFloor(50)).toBe(1800); // 50*30=1500 < 1800
  });

  it('uses the lean-mass-derived floor when higher than the safety net', () => {
    expect(kcalFloor(70)).toBe(2100); // 70*30=2100 > 1800
  });
});

describe('bmi / isBelowBmiFloor', () => {
  it('computes BMI from weight and height', () => {
    expect(bmi(70, 175)).toBeCloseTo(22.86, 2);
  });

  it('flags BMI below the floor', () => {
    expect(isBelowBmiFloor(50, 175)).toBe(true); // bmi ~16.33
    expect(isBelowBmiFloor(70, 175)).toBe(false); // bmi ~22.86
  });
});

describe('proteinTargetRangeG', () => {
  it('returns the 2.0-2.2 g/kg range', () => {
    expect(proteinTargetRangeG(70)).toEqual({ minG: 140, maxG: 154 });
  });
});

describe('resolveGoal', () => {
  it('keeps the requested rate when under the cap', () => {
    const result = resolveGoal({ currentWeightKg: 80, targetWeightKg: 74, requestedWeeks: 12 });
    expect(result.adjusted).toBe(false);
    expect(result.ratePctPerWeek).toBeCloseTo(0.625, 3);
    expect(result.weeks).toBe(12);
  });

  it('lengthens the horizon instead of exceeding RATE_MAX_PCT', () => {
    const result = resolveGoal({ currentWeightKg: 80, targetWeightKg: 70, requestedWeeks: 8 });
    expect(result.adjusted).toBe(true);
    expect(result.ratePctPerWeek).toBe(RATE_MAX_PCT);
    expect(result.weeks).toBe(17);
  });
});

describe('re-baseline', () => {
  it('records the day it was triggered', () => {
    expect(triggerRebaseline('2026-09-09')).toEqual({ baselineStartedAt: '2026-09-09' });
  });

  it('stays locked until lockDays have passed', () => {
    expect(isBaselineLocked('2026-09-01', '2026-09-10', 14)).toBe(true);
    expect(isBaselineLocked('2026-09-01', '2026-09-20', 14)).toBe(false);
  });
});

describe('isStagnating', () => {
  it('is true when 3 consecutive weekly points vary less than the threshold', () => {
    const points = [
      { weekStartDate: '2026-08-19', avgWeightKg: 80.0 },
      { weekStartDate: '2026-08-26', avgWeightKg: 79.95 },
      { weekStartDate: '2026-09-02', avgWeightKg: 79.9 },
    ];
    expect(isStagnating(points)).toBe(true);
  });

  it('is false when any consecutive change meets or exceeds the threshold', () => {
    const points = [
      { weekStartDate: '2026-08-19', avgWeightKg: 80.0 },
      { weekStartDate: '2026-08-26', avgWeightKg: 79.5 },
      { weekStartDate: '2026-09-02', avgWeightKg: 79.0 },
    ];
    expect(isStagnating(points)).toBe(false);
  });

  it('is false with fewer than 3 points', () => {
    expect(isStagnating([{ weekStartDate: '2026-08-19', avgWeightKg: 80 }])).toBe(false);
  });
});

describe('needsScheduledDietBreak', () => {
  it('is false before 8 weeks', () => {
    expect(needsScheduledDietBreak(7)).toBe(false);
  });

  it('is true from 8 weeks onward', () => {
    expect(needsScheduledDietBreak(8)).toBe(true);
    expect(needsScheduledDietBreak(10)).toBe(true);
  });
});

describe('isPerformanceDeclining', () => {
  it('is true after two consecutive weekly drops', () => {
    expect(isPerformanceDeclining([100, 95, 90])).toBe(true);
  });

  it('is false when performance is flat or improving', () => {
    expect(isPerformanceDeclining([90, 95, 100])).toBe(false);
  });

  it('is false with fewer than 3 weekly scores', () => {
    expect(isPerformanceDeclining([100, 95])).toBe(false);
  });
});

describe('blocksDownwardAdjustmentFromSleep', () => {
  it('blocks after two consecutive bad nights', () => {
    expect(blocksDownwardAdjustmentFromSleep(['bad', 'bad'])).toBe(true);
  });

  it('does not block otherwise', () => {
    expect(blocksDownwardAdjustmentFromSleep(['bad', 'good'])).toBe(false);
    expect(blocksDownwardAdjustmentFromSleep(['good', 'good'])).toBe(false);
  });
});
