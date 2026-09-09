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
