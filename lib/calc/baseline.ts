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
