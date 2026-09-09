# Étape 2 — /lib/calc : TDEE, moyennes glissantes, ajustement, garde-fous — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entire deterministic calculation layer (`/lib/calc`) described in v4 §12 — TDEE (predicted + observed), rolling averages, target adjustment, baseline/goal/diet-break logic, and numeric guardrails — as pure, unit-tested TypeScript functions with zero LLM involvement.

**Architecture:** Five independent-but-layered modules matching the spec's prescribed file list. `rolling.ts` provides date/series math with no dependencies. `tdee.ts` is standalone (predicted + observed TDEE, no shared state). `baseline.ts` depends on `rolling.ts`'s `daysSince` and owns all the target-setting constants. `adjust.ts` depends on `rolling.ts`'s `daysSince` only (baseline-lock state is passed in as a plain boolean, not imported, to keep it decoupled). `guardrails.ts` depends on `baseline.ts`'s `isBelowBmiFloor`. Every function is pure (no I/O, no `Date.now()`, no randomness) so it is trivially unit-testable and framework-free — the future cron/recompute job (a later step) is the only caller that touches real dates and database rows.

**Tech Stack:** TypeScript (ESM), Vitest — no new runtime dependencies.

**Spec:** `docs/spec-agent-nutrition-v4.md` §4 (target rules), §5 (double TDEE estimator), §6 (adaptation loop: rolling averages, atypical-day exclusion, re-baseline, diet break, performance-as-signal, sleep rule), §10 (guardrails), §12 (module list: `tdee.ts`, `rolling.ts`, `adjust.ts`, `baseline.ts`, `guardrails.ts`).

## Global Constraints

- Every function in `/lib/calc` is pure: no `Date.now()`, no DB access, no LLM calls — inputs and outputs only.
- Dates are plain `YYYY-MM-DD` strings throughout; `new Date('YYYY-MM-DD')` parses as UTC midnight, so all date math stays UTC-consistent. Do not mix in datetime strings with a time component.
- Rate/percentage constants come verbatim from spec §4: `RATE_MAX_PCT = 0.75`, `RATE_DEFAULT_PCT = 0.5`, `DEFICIT_MAX_PCT = 20`, `KCAL_PER_KG_LBM = 30`, `KCAL_FLOOR_ABS = 1800`, `BMI_FLOOR = 18.5`. Protein range: `2.0`–`2.2` g/kg body weight (spec §4).
- Adjustment step size: max `100` kcal per change, at most once per 7 days (spec §6). No stated cap exists for the "too fast" upward correction beyond this same step size — this plan uses the same ±100 kcal step for both directions for consistency (see Task 4 notes).
- Rapid-loss alert threshold: `>1%` of body weight over a week — strictly greater than, not inclusive (spec §10.5).
- Guardrails #4 (eating-disorder-signal detection) and #7 (no medical advice) from spec §10 are **not** part of this plan — they are language/NLP-driven behavioral rules that belong in a later onboarding/router step, not deterministic math. Only the numeric guardrails (#1 floor, #2 rate cap, #3 BMI refusal, #5 rapid loss, #6 RED-S signal combination, #8 rest-day monitoring) are implemented here.

---

## File Structure

```
/lib/calc
  rolling.ts     # averageOf, excludeAtypical, sevenDayAverageWeight, fourteenDayAverageKcal, daysSince
  tdee.ts        # predictedTdee, observedTdee, tdeeComparison
  baseline.ts    # constants, kcalFloor, bmi, isBelowBmiFloor, proteinTargetRangeG, resolveGoal,
                 # triggerRebaseline, isBaselineLocked, isStagnating, needsScheduledDietBreak,
                 # isPerformanceDeclining, blocksDownwardAdjustmentFromSleep
  adjust.ts      # computeAdjustment
  guardrails.ts  # clampToFloor, shouldRefuseProgram, isRapidLossAlert, isRedsAlert, needsRestDayWarning
/tests/calc
  rolling.test.ts
  tdee.test.ts
  baseline.test.ts
  adjust.test.ts
  guardrails.test.ts
```

---

### Task 1: `lib/calc/rolling.ts` — date/series math

**Files:**
- Create: `lib/calc/rolling.ts`
- Test: `tests/calc/rolling.test.ts`

**Interfaces:**
- Produces:
  - `averageOf(values: number[]): number`
  - `export interface DailyIntake { date: string; kcal: number; isAtypical: boolean }`
  - `excludeAtypical(intakes: DailyIntake[]): DailyIntake[]`
  - `fourteenDayAverageKcal(intakes: DailyIntake[]): number`
  - `sevenDayAverageWeight(weightsKg: number[]): number`
  - `daysSince(fromDate: string, toDate: string): number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/calc/rolling.test.ts
import { describe, it, expect } from 'vitest';
import {
  averageOf,
  excludeAtypical,
  fourteenDayAverageKcal,
  sevenDayAverageWeight,
  daysSince,
} from '../../lib/calc/rolling.js';
import type { DailyIntake } from '../../lib/calc/rolling.js';

describe('averageOf', () => {
  it('averages a list of numbers', () => {
    expect(averageOf([2000, 2200, 2100])).toBe(2100);
  });

  it('throws on an empty array', () => {
    expect(() => averageOf([])).toThrow('averageOf: empty array');
  });
});

describe('excludeAtypical', () => {
  it('filters out entries marked atypical', () => {
    const intakes: DailyIntake[] = [
      { date: '2026-09-01', kcal: 2000, isAtypical: false },
      { date: '2026-09-02', kcal: 3500, isAtypical: true },
      { date: '2026-09-03', kcal: 2100, isAtypical: false },
    ];
    expect(excludeAtypical(intakes)).toEqual([
      { date: '2026-09-01', kcal: 2000, isAtypical: false },
      { date: '2026-09-03', kcal: 2100, isAtypical: false },
    ]);
  });
});

describe('fourteenDayAverageKcal', () => {
  it('averages kcal after removing atypical days', () => {
    const intakes: DailyIntake[] = [
      { date: '2026-09-01', kcal: 2000, isAtypical: false },
      { date: '2026-09-02', kcal: 4000, isAtypical: true },
      { date: '2026-09-03', kcal: 2200, isAtypical: false },
    ];
    expect(fourteenDayAverageKcal(intakes)).toBe(2100);
  });
});

describe('sevenDayAverageWeight', () => {
  it('averages a window of weights', () => {
    expect(sevenDayAverageWeight([80, 79.5, 79.8, 79.2, 79.6, 79.1, 79.3])).toBeCloseTo(79.5, 5);
  });
});

describe('daysSince', () => {
  it('counts whole days between two UTC dates', () => {
    expect(daysSince('2026-01-01', '2026-01-10')).toBe(9);
  });

  it('returns 0 for the same date', () => {
    expect(daysSince('2026-01-01', '2026-01-01')).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/rolling.test.ts`
Expected: FAIL — `Cannot find module '../../lib/calc/rolling.js'`.

- [ ] **Step 3: Create `lib/calc/rolling.ts`**

```ts
export interface DailyIntake {
  date: string;
  kcal: number;
  isAtypical: boolean;
}

export function averageOf(values: number[]): number {
  if (values.length === 0) throw new Error('averageOf: empty array');
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function excludeAtypical(intakes: DailyIntake[]): DailyIntake[] {
  return intakes.filter((intake) => !intake.isAtypical);
}

export function fourteenDayAverageKcal(intakes: DailyIntake[]): number {
  return averageOf(excludeAtypical(intakes).map((intake) => intake.kcal));
}

export function sevenDayAverageWeight(weightsKg: number[]): number {
  return averageOf(weightsKg);
}

// Dates are plain YYYY-MM-DD strings, parsed as UTC midnight by `new Date()`.
export function daysSince(fromDate: string, toDate: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / msPerDay);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/calc/rolling.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/calc/rolling.ts tests/calc/rolling.test.ts
git commit -m "feat(calc): rolling averages and date math"
```

---

### Task 2: `lib/calc/tdee.ts` — predicted and observed TDEE

**Files:**
- Create: `lib/calc/tdee.ts`
- Test: `tests/calc/tdee.test.ts`

**Interfaces:**
- Produces:
  - `export interface PredictedTdeeInput { leanMassKg: number; activityFactor: number; plannedSegmentsKcal: number }`
  - `predictedTdee(input: PredictedTdeeInput): number`
  - `observedTdee(avgKcal: number, weightStartKg: number, weightEndKg: number, days?: number): number`
  - `export interface TdeeComparison { predicted: number; observed: number; deltaPct: number; dataQualityFlag: boolean }`
  - `tdeeComparison(predicted: number, observed: number): TdeeComparison`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/calc/tdee.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/tdee.test.ts`
Expected: FAIL — `Cannot find module '../../lib/calc/tdee.js'`.

- [ ] **Step 3: Create `lib/calc/tdee.ts`**

```ts
export interface PredictedTdeeInput {
  leanMassKg: number;
  activityFactor: number;
  plannedSegmentsKcal: number;
}

// Katch-McArdle BMR (uses measured lean mass, per spec §5) times a base activity
// factor gives the day's baseline expenditure; today's planned segments (workouts,
// commute) are added on top since they vary day to day.
export function predictedTdee(input: PredictedTdeeInput): number {
  const bmr = 370 + 21.6 * input.leanMassKg;
  return bmr * input.activityFactor + input.plannedSegmentsKcal;
}

export function observedTdee(
  avgKcal: number,
  weightStartKg: number,
  weightEndKg: number,
  days = 14
): number {
  const deltaKg = weightEndKg - weightStartKg;
  return avgKcal - (deltaKg * 7700) / days;
}

export interface TdeeComparison {
  predicted: number;
  observed: number;
  deltaPct: number;
  dataQualityFlag: boolean;
}

const TDEE_GAP_FLAG_PCT = 25;

export function tdeeComparison(predicted: number, observed: number): TdeeComparison {
  const deltaPct = ((observed - predicted) / predicted) * 100;
  return {
    predicted,
    observed,
    deltaPct,
    dataQualityFlag: Math.abs(deltaPct) > TDEE_GAP_FLAG_PCT,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/calc/tdee.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/calc/tdee.ts tests/calc/tdee.test.ts
git commit -m "feat(calc): predicted and observed TDEE"
```

---

### Task 3: `lib/calc/baseline.ts` — targets, goals, diet-break, performance signal

**Files:**
- Create: `lib/calc/baseline.ts`
- Test: `tests/calc/baseline.test.ts`

**Interfaces:**
- Consumes: `daysSince` from `lib/calc/rolling.ts` (Task 1).
- Produces:
  - Constants: `RATE_MAX_PCT`, `RATE_DEFAULT_PCT`, `DEFICIT_MAX_PCT`, `KCAL_PER_KG_LBM`, `KCAL_FLOOR_ABS`, `BMI_FLOOR`, `PROTEIN_MIN_G_PER_KG`, `PROTEIN_MAX_G_PER_KG`
  - `kcalFloor(leanMassKg: number): number`
  - `bmi(weightKg: number, heightCm: number): number`
  - `isBelowBmiFloor(weightKg: number, heightCm: number): boolean`
  - `proteinTargetRangeG(weightKg: number): { minG: number; maxG: number }`
  - `export interface GoalInput { currentWeightKg: number; targetWeightKg: number; requestedWeeks: number }`
  - `export interface GoalResult { ratePctPerWeek: number; weeks: number; adjusted: boolean }`
  - `resolveGoal(input: GoalInput): GoalResult`
  - `export interface RebaselineState { baselineStartedAt: string }`
  - `triggerRebaseline(today: string): RebaselineState`
  - `isBaselineLocked(baselineStartedAt: string, today: string, lockDays?: number): boolean`
  - `export interface WeeklyWeightPoint { weekStartDate: string; avgWeightKg: number }`
  - `isStagnating(weeklyPoints: WeeklyWeightPoint[], thresholdPct?: number): boolean`
  - `needsScheduledDietBreak(consecutiveDeficitWeeks: number): boolean`
  - `isPerformanceDeclining(weeklyScores: number[]): boolean`
  - `export type SleepQuality = 'good' | 'medium' | 'bad'`
  - `blocksDownwardAdjustmentFromSleep(lastTwoNights: SleepQuality[]): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/calc/baseline.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/baseline.test.ts`
Expected: FAIL — `Cannot find module '../../lib/calc/baseline.js'`.

- [ ] **Step 3: Create `lib/calc/baseline.ts`**

```ts
import { daysSince } from './rolling.js';

export const RATE_MAX_PCT = 0.75;
export const RATE_DEFAULT_PCT = 0.5;
export const DEFICIT_MAX_PCT = 20;
export const KCAL_PER_KG_LBM = 30;
export const KCAL_FLOOR_ABS = 1800;
export const BMI_FLOOR = 18.5;
export const PROTEIN_MIN_G_PER_KG = 2.0;
export const PROTEIN_MAX_G_PER_KG = 2.2;

export function kcalFloor(leanMassKg: number): number {
  return Math.max(KCAL_FLOOR_ABS, leanMassKg * KCAL_PER_KG_LBM);
}

export function bmi(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

export function isBelowBmiFloor(weightKg: number, heightCm: number): boolean {
  return bmi(weightKg, heightCm) < BMI_FLOOR;
}

export function proteinTargetRangeG(weightKg: number): { minG: number; maxG: number } {
  return {
    minG: weightKg * PROTEIN_MIN_G_PER_KG,
    maxG: weightKg * PROTEIN_MAX_G_PER_KG,
  };
}

export interface GoalInput {
  currentWeightKg: number;
  targetWeightKg: number;
  requestedWeeks: number;
}

export interface GoalResult {
  ratePctPerWeek: number;
  weeks: number;
  adjusted: boolean;
}

// Never deepen the deficit past RATE_MAX_PCT: lengthen the horizon instead.
export function resolveGoal(input: GoalInput): GoalResult {
  const totalDeltaKg = input.currentWeightKg - input.targetWeightKg;
  const requestedRatePct = (totalDeltaKg / input.requestedWeeks / input.currentWeightKg) * 100;

  if (requestedRatePct <= RATE_MAX_PCT) {
    return { ratePctPerWeek: requestedRatePct, weeks: input.requestedWeeks, adjusted: false };
  }

  const maxWeeklyLossKg = input.currentWeightKg * (RATE_MAX_PCT / 100);
  const weeks = Math.ceil(totalDeltaKg / maxWeeklyLossKg);
  return { ratePctPerWeek: RATE_MAX_PCT, weeks, adjusted: true };
}

export interface RebaselineState {
  baselineStartedAt: string;
}

export function triggerRebaseline(today: string): RebaselineState {
  return { baselineStartedAt: today };
}

export function isBaselineLocked(baselineStartedAt: string, today: string, lockDays = 14): boolean {
  return daysSince(baselineStartedAt, today) < lockDays;
}

export interface WeeklyWeightPoint {
  weekStartDate: string;
  avgWeightKg: number;
}

export function isStagnating(weeklyPoints: WeeklyWeightPoint[], thresholdPct = 0.2): boolean {
  if (weeklyPoints.length < 3) return false;
  const last3 = weeklyPoints.slice(-3);
  for (let i = 1; i < last3.length; i++) {
    const prev = last3[i - 1].avgWeightKg;
    const curr = last3[i].avgWeightKg;
    const changePct = (Math.abs(curr - prev) / prev) * 100;
    if (changePct >= thresholdPct) return false;
  }
  return true;
}

export function needsScheduledDietBreak(consecutiveDeficitWeeks: number): boolean {
  return consecutiveDeficitWeeks >= 8;
}

// "Two weeks of decline" = the last two week-over-week transitions both dropped.
// Callers normalize inputs so higher is always better (e.g. invert RPE before passing it in).
export function isPerformanceDeclining(weeklyScores: number[]): boolean {
  if (weeklyScores.length < 3) return false;
  const [a, b, c] = weeklyScores.slice(-3);
  return b < a && c < b;
}

export type SleepQuality = 'good' | 'medium' | 'bad';

export function blocksDownwardAdjustmentFromSleep(lastTwoNights: SleepQuality[]): boolean {
  return lastTwoNights.length === 2 && lastTwoNights.every((n) => n === 'bad');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/calc/baseline.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/calc/baseline.ts tests/calc/baseline.test.ts
git commit -m "feat(calc): goal resolution, re-baseline, diet break, performance and sleep signals"
```

---

### Task 4: `lib/calc/adjust.ts` — weekly target adjustment

**Files:**
- Create: `lib/calc/adjust.ts`
- Test: `tests/calc/adjust.test.ts`

**Interfaces:**
- Consumes: `daysSince` from `lib/calc/rolling.ts` (Task 1).
- Produces:
  - `export interface AdjustmentInput { currentTargetKcal: number; targetRateKgPerWeek: number; observedRateKgPerWeek: number; kcalFloor: number; isBaselineLocked: boolean; lastAdjustmentDate: string | null; today: string }`
  - `export interface AdjustmentResult { newTargetKcal: number; changed: boolean; reason: string }`
  - `computeAdjustment(input: AdjustmentInput): AdjustmentResult`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/calc/adjust.test.ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/adjust.test.ts`
Expected: FAIL — `Cannot find module '../../lib/calc/adjust.js'`.

- [ ] **Step 3: Create `lib/calc/adjust.ts`**

```ts
import { daysSince } from './rolling.js';

export interface AdjustmentInput {
  currentTargetKcal: number;
  targetRateKgPerWeek: number;
  observedRateKgPerWeek: number;
  kcalFloor: number;
  isBaselineLocked: boolean;
  lastAdjustmentDate: string | null;
  today: string;
}

export interface AdjustmentResult {
  newTargetKcal: number;
  changed: boolean;
  reason: string;
}

const MAX_STEP_KCAL = 100;
const RATE_GAP_TOLERANCE_PCT = 20;
const MIN_DAYS_BETWEEN_ADJUSTMENTS = 7;

export function computeAdjustment(input: AdjustmentInput): AdjustmentResult {
  if (input.isBaselineLocked) {
    return { newTargetKcal: input.currentTargetKcal, changed: false, reason: 'baseline locked' };
  }

  if (
    input.lastAdjustmentDate !== null &&
    daysSince(input.lastAdjustmentDate, input.today) < MIN_DAYS_BETWEEN_ADJUSTMENTS
  ) {
    return { newTargetKcal: input.currentTargetKcal, changed: false, reason: 'already adjusted this week' };
  }

  const gapPct =
    (Math.abs(input.observedRateKgPerWeek - input.targetRateKgPerWeek) / Math.abs(input.targetRateKgPerWeek)) * 100;

  if (gapPct < RATE_GAP_TOLERANCE_PCT) {
    return { newTargetKcal: input.currentTargetKcal, changed: false, reason: 'within tolerance' };
  }

  if (input.observedRateKgPerWeek < input.targetRateKgPerWeek) {
    const newTargetKcal = Math.max(input.kcalFloor, input.currentTargetKcal - MAX_STEP_KCAL);
    return { newTargetKcal, changed: newTargetKcal !== input.currentTargetKcal, reason: 'too slow' };
  }

  const newTargetKcal = input.currentTargetKcal + MAX_STEP_KCAL;
  return { newTargetKcal, changed: true, reason: 'too fast' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/calc/adjust.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/calc/adjust.ts tests/calc/adjust.test.ts
git commit -m "feat(calc): weekly target adjustment"
```

---

### Task 5: `lib/calc/guardrails.ts` — numeric safety checks

**Files:**
- Create: `lib/calc/guardrails.ts`
- Test: `tests/calc/guardrails.test.ts`

**Interfaces:**
- Consumes: `isBelowBmiFloor` from `lib/calc/baseline.ts` (Task 3).
- Produces:
  - `clampToFloor(targetKcal: number, kcalFloor: number): number`
  - `shouldRefuseProgram(currentWeightKg: number, targetWeightKg: number, heightCm: number): boolean`
  - `isRapidLossAlert(weightStartKg: number, weightEndKg: number): boolean`
  - `export interface RedsSignals { highVolume: boolean; inDeficit: boolean; performanceDeclining: boolean; highFatigue: boolean }`
  - `isRedsAlert(signals: RedsSignals): boolean`
  - `needsRestDayWarning(consecutiveDaysWithoutRest: number): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/calc/guardrails.test.ts
import { describe, it, expect } from 'vitest';
import {
  clampToFloor,
  shouldRefuseProgram,
  isRapidLossAlert,
  isRedsAlert,
  needsRestDayWarning,
} from '../../lib/calc/guardrails.js';

describe('clampToFloor', () => {
  it('raises the target up to the floor when below it', () => {
    expect(clampToFloor(2050, 2100)).toBe(2100);
  });

  it('leaves the target untouched when already above the floor', () => {
    expect(clampToFloor(2200, 2100)).toBe(2200);
  });
});

describe('shouldRefuseProgram', () => {
  it('refuses when the current weight is already below the BMI floor', () => {
    expect(shouldRefuseProgram(50, 48, 175)).toBe(true);
  });

  it('refuses when the target weight would lead below the BMI floor', () => {
    expect(shouldRefuseProgram(70, 55, 175)).toBe(true);
  });

  it('allows the program when both weights stay above the BMI floor', () => {
    expect(shouldRefuseProgram(70, 65, 175)).toBe(false);
  });
});

describe('isRapidLossAlert', () => {
  it('alerts above 1% body weight lost over the week', () => {
    expect(isRapidLossAlert(80, 79)).toBe(true); // 1.25%
  });

  it('does not alert at exactly 1%', () => {
    expect(isRapidLossAlert(100, 99)).toBe(false);
  });

  it('does not alert under 1%', () => {
    expect(isRapidLossAlert(80, 79.5)).toBe(false);
  });
});

describe('isRedsAlert', () => {
  it('alerts only when all four signals are present', () => {
    expect(
      isRedsAlert({ highVolume: true, inDeficit: true, performanceDeclining: true, highFatigue: true })
    ).toBe(true);
  });

  it('does not alert when any signal is missing', () => {
    expect(
      isRedsAlert({ highVolume: true, inDeficit: true, performanceDeclining: false, highFatigue: true })
    ).toBe(false);
  });
});

describe('needsRestDayWarning', () => {
  it('is false under 10 consecutive days without a full rest day', () => {
    expect(needsRestDayWarning(9)).toBe(false);
  });

  it('is true at 10 or more consecutive days', () => {
    expect(needsRestDayWarning(10)).toBe(true);
    expect(needsRestDayWarning(11)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/guardrails.test.ts`
Expected: FAIL — `Cannot find module '../../lib/calc/guardrails.js'`.

- [ ] **Step 3: Create `lib/calc/guardrails.ts`**

```ts
import { isBelowBmiFloor } from './baseline.js';

export function clampToFloor(targetKcal: number, kcalFloor: number): number {
  return Math.max(targetKcal, kcalFloor);
}

export function shouldRefuseProgram(currentWeightKg: number, targetWeightKg: number, heightCm: number): boolean {
  return isBelowBmiFloor(currentWeightKg, heightCm) || isBelowBmiFloor(targetWeightKg, heightCm);
}

export function isRapidLossAlert(weightStartKg: number, weightEndKg: number): boolean {
  const changePct = ((weightStartKg - weightEndKg) / weightStartKg) * 100;
  return changePct > 1;
}

export interface RedsSignals {
  highVolume: boolean;
  inDeficit: boolean;
  performanceDeclining: boolean;
  highFatigue: boolean;
}

export function isRedsAlert(signals: RedsSignals): boolean {
  return signals.highVolume && signals.inDeficit && signals.performanceDeclining && signals.highFatigue;
}

export function needsRestDayWarning(consecutiveDaysWithoutRest: number): boolean {
  return consecutiveDaysWithoutRest >= 10;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/calc/guardrails.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass (44 tests across the whole project), no type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/calc/guardrails.ts tests/calc/guardrails.test.ts
git commit -m "feat(calc): numeric guardrails (BMI, rapid loss, RED-S, rest day)"
```

---

## Self-Review

**Spec coverage:**
- §4 target rules (constants, floor, BMI refusal, protein range, horizon-lengthening) → Task 3 (`baseline.ts`), Task 5 (`shouldRefuseProgram`). ✅
- §5 double TDEE estimator (predicted, observed, delta tracking, >25% flag, no-double-counting note) → Task 2 (`tdee.ts`). ✅ (the no-double-counting rule is a caller-side discipline, not a function — noted in Task 2's code comment and this plan's constraints.)
- §6 adaptation loop: rolling averages, atypical-day exclusion → Task 1. Adjustment logic, floor, weekly cap, baseline lock → Task 3 + Task 4. Re-baseline → Task 3. Diet break (stagnation + scheduled) → Task 3. Performance-as-signal → Task 3. Sleep rule → Task 3. ✅
- §10 guardrails: floor (#1) → `kcalFloor`/`clampToFloor` (Tasks 3, 5). Rate cap (#2) → `resolveGoal` (Task 3). BMI refusal (#3) → Task 5. ED-signal detection (#4) and no-medical-advice (#7) → explicitly out of scope, documented in Global Constraints as belonging to a later NLP/router step. Rapid loss (#5) and RED-S (#6) → Task 5. Rest day (#8) → Task 5. ✅

**Placeholder scan:** none found — every step has runnable code and concrete expected numeric output computed by hand.

**Type consistency:** `daysSince` signature (Task 1: `(fromDate: string, toDate: string) => number`) is used identically in Task 3's `isBaselineLocked` and Task 4's `computeAdjustment`. `isBelowBmiFloor` signature (Task 3: `(weightKg: number, heightCm: number) => boolean`) matches its Task 5 call site in `shouldRefuseProgram`. No mismatches between task interfaces and their consumers.
