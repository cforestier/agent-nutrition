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
