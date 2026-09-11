import { prisma } from './db.js';
import { addDays, weekdayOf } from './dateUtils.js';
import { fourteenDayAverageKcal, sevenDayAverageWeight, type DailyIntake } from './calc/rolling.js';
import { predictedTdee, observedTdee, tdeeComparison, BASE_ACTIVITY_FACTOR } from './calc/tdee.js';
import {
  isBaselineLocked,
  isStagnating,
  needsScheduledDietBreak,
  blocksDownwardAdjustmentFromSleep,
  type WeeklyWeightPoint,
} from './calc/baseline.js';
import { computeAdjustment } from './calc/adjust.js';
import { getProfileSnapshot, applyRecomputeToProfile } from './profile.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import { recentSleepQualities } from './sleep.js';
import type { MealItem } from './meals.js';

export interface DailyRecomputeResult {
  date: string;
  totalKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  weightKg: number | null;
  rolling7Weight: number | null;
  rolling14Kcal: number | null;
  observedTdeeKcal: number | null;
  predictedTdeeKcal: number | null;
  targetKcal: number | null;
  isExcluded: boolean;
  adherenceFlag: boolean | null;
  adjustmentReason: string | null;
  dietBreakRecommended: boolean;
  stagnating: boolean;
}

function centeredWeights(weightByDate: Map<string, number>, centerDate: string): number[] {
  const values: number[] = [];
  for (let offset = -3; offset <= 3; offset++) {
    const value = weightByDate.get(addDays(centerDate, offset));
    if (value !== undefined) values.push(value);
  }
  return values;
}

function buildWeeklyWeightPoints(weightByDate: Map<string, number>, today: string): WeeklyWeightPoint[] {
  const points: WeeklyWeightPoint[] = [];
  for (let weeksAgo = 3; weeksAgo >= 0; weeksAgo--) {
    const weekStartDate = addDays(today, -7 * weeksAgo - 6);
    const values: number[] = [];
    for (let offset = 0; offset <= 6; offset++) {
      const value = weightByDate.get(addDays(weekStartDate, offset));
      if (value !== undefined) values.push(value);
    }
    if (values.length > 0) {
      points.push({ weekStartDate, avgWeightKg: values.reduce((s, v) => s + v, 0) / values.length });
    }
  }
  return points;
}

export async function runDailyRecompute(date: string): Promise<DailyRecomputeResult> {
  const windowStart = addDays(date, -13);
  const dayStart = new Date(`${windowStart}T00:00:00Z`);
  const dayEndExclusive = new Date(`${addDays(date, 1)}T00:00:00Z`);

  const [meals, dayPlans, weights, weeklyDefault, profile, recentSleep] = await Promise.all([
    prisma.meal.findMany({ where: { datetime: { gte: dayStart, lt: dayEndExclusive } } }),
    prisma.dayPlan.findMany({ where: { date: { gte: windowStart, lte: date } } }),
    prisma.weight.findMany({ where: { date: { gte: addDays(date, -20), lte: addDays(date, 3) } } }),
    getWeeklyDefault(weekdayOf(date)),
    getProfileSnapshot(),
    recentSleepQualities(),
  ]);

  const kcalByDate = new Map<string, number>();
  const macrosByDate = new Map<string, { proteinG: number; carbsG: number; fatG: number }>();
  for (const meal of meals) {
    const day = meal.datetime.toLocaleDateString('en-CA');
    kcalByDate.set(day, (kcalByDate.get(day) ?? 0) + meal.kcalMid);
    const items = meal.items as unknown as MealItem[];
    const macros = macrosByDate.get(day) ?? { proteinG: 0, carbsG: 0, fatG: 0 };
    for (const item of items) {
      macros.proteinG += item.proteinG;
      macros.carbsG += item.carbsG;
      macros.fatG += item.fatG;
    }
    macrosByDate.set(day, macros);
  }

  const isAtypicalByDate = new Map(dayPlans.map((p) => [p.date, p.isAtypical]));
  const eventBonusByDate = new Map(dayPlans.map((p) => [p.date, p.eventBonusKcal ?? 0]));
  const weightByDate = new Map(weights.map((w) => [w.date, w.weightKg]));

  const intakes: DailyIntake[] = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(date, -13 + i);
    const kcal = kcalByDate.get(day);
    if (kcal !== undefined) {
      intakes.push({ date: day, kcal, isAtypical: isAtypicalByDate.get(day) ?? false });
    }
  }
  const rolling14Kcal = intakes.length > 0 ? fourteenDayAverageKcal(intakes) : null;

  const startWindow = centeredWeights(weightByDate, addDays(date, -14));
  const endWindow = centeredWeights(weightByDate, date);
  const weightStart = startWindow.length > 0 ? sevenDayAverageWeight(startWindow) : null;
  const weightEnd = endWindow.length > 0 ? sevenDayAverageWeight(endWindow) : null;

  const observedTdeeKcal =
    rolling14Kcal !== null && weightStart !== null && weightEnd !== null
      ? observedTdee(rolling14Kcal, weightStart, weightEnd)
      : null;

  const predictedTdeeKcal =
    profile.leanMassKg !== null
      ? predictedTdee({
          leanMassKg: profile.leanMassKg,
          activityFactor: BASE_ACTIVITY_FACTOR,
          plannedSegmentsKcal: weeklyDefault?.avgKcal ?? 0,
        })
      : null;

  if (predictedTdeeKcal !== null && observedTdeeKcal !== null) {
    const comparison = tdeeComparison(predictedTdeeKcal, observedTdeeKcal);
    await prisma.tdeeComparison.upsert({
      where: { date },
      create: { date, predicted: comparison.predicted, observed: comparison.observed, deltaPct: comparison.deltaPct },
      update: { predicted: comparison.predicted, observed: comparison.observed, deltaPct: comparison.deltaPct },
    });
  }

  let targetKcal = profile.currentTargetKcal;
  let adherenceFlag: boolean | null = null;
  let adjustmentReason: string | null = null;
  let dietBreakRecommended = false;
  let stagnating = false;

  if (
    targetKcal !== null &&
    profile.kcalFloor !== null &&
    profile.weightKg !== null &&
    profile.ratePctPerWeek !== null &&
    observedTdeeKcal !== null &&
    weightStart !== null &&
    weightEnd !== null
  ) {
    const baselineLocked = profile.baselineStartedAt !== null && isBaselineLocked(profile.baselineStartedAt, date);
    const targetRateKgPerWeek = (profile.ratePctPerWeek / 100) * profile.weightKg;
    const observedRateKgPerWeek = ((weightStart - weightEnd) / 14) * 7;
    const sleepBlocksDownward = blocksDownwardAdjustmentFromSleep(recentSleep);

    const result = computeAdjustment({
      currentTargetKcal: targetKcal,
      targetRateKgPerWeek,
      observedRateKgPerWeek,
      kcalFloor: profile.kcalFloor,
      isBaselineLocked: baselineLocked,
      lastAdjustmentDate: profile.lastAdjustmentDate,
      today: date,
      sleepBlocksDownwardAdjustment: sleepBlocksDownward,
    });

    adjustmentReason = result.reason;
    const evaluatedThisWeek = result.reason !== 'baseline locked' && result.reason !== 'already adjusted this week';
    adherenceFlag = evaluatedThisWeek ? result.reason === 'within tolerance' : null;

    if (evaluatedThisWeek) {
      const weeklyPoints = buildWeeklyWeightPoints(weightByDate, date);
      stagnating = isStagnating(weeklyPoints);
      dietBreakRecommended = stagnating || needsScheduledDietBreak(profile.consecutiveDeficitWeeks);

      let finalTargetKcal = result.newTargetKcal;
      if (dietBreakRecommended) {
        finalTargetKcal = Math.max(finalTargetKcal, observedTdeeKcal);
      }

      const nextConsecutiveDeficitWeeks = dietBreakRecommended ? 0 : profile.consecutiveDeficitWeeks + 1;

      if (finalTargetKcal !== profile.currentTargetKcal || dietBreakRecommended) {
        await applyRecomputeToProfile({
          currentTargetKcal: finalTargetKcal,
          lastAdjustmentDate: date,
          consecutiveDeficitWeeks: nextConsecutiveDeficitWeeks,
        });
      }

      targetKcal = finalTargetKcal;
    }
  }

  const eventBonusKcal = eventBonusByDate.get(date) ?? 0;
  if (targetKcal !== null && eventBonusKcal !== 0) {
    targetKcal = targetKcal + eventBonusKcal;
  }

  const todayMacros = macrosByDate.get(date) ?? { proteinG: 0, carbsG: 0, fatG: 0 };
  const totalKcal = kcalByDate.get(date) ?? 0;
  const isExcluded = isAtypicalByDate.get(date) ?? false;
  const weightKgToday = weightByDate.get(date) ?? null;

  await prisma.dailyState.upsert({
    where: { date },
    create: {
      date,
      totalKcal,
      proteinG: todayMacros.proteinG,
      carbsG: todayMacros.carbsG,
      fatG: todayMacros.fatG,
      weightKg: weightKgToday,
      rolling7Weight: weightEnd,
      rolling14Kcal,
      observedTdee: observedTdeeKcal,
      predictedTdee: predictedTdeeKcal,
      targetKcal,
      isExcluded,
      adherenceFlag,
      dietBreakRecommended,
    },
    update: {
      totalKcal,
      proteinG: todayMacros.proteinG,
      carbsG: todayMacros.carbsG,
      fatG: todayMacros.fatG,
      weightKg: weightKgToday,
      rolling7Weight: weightEnd,
      rolling14Kcal,
      observedTdee: observedTdeeKcal,
      predictedTdee: predictedTdeeKcal,
      targetKcal,
      isExcluded,
      adherenceFlag,
      dietBreakRecommended,
    },
  });

  return {
    date,
    totalKcal,
    proteinG: todayMacros.proteinG,
    carbsG: todayMacros.carbsG,
    fatG: todayMacros.fatG,
    weightKg: weightKgToday,
    rolling7Weight: weightEnd,
    rolling14Kcal,
    observedTdeeKcal,
    predictedTdeeKcal,
    targetKcal,
    isExcluded,
    adherenceFlag,
    adjustmentReason,
    dietBreakRecommended,
    stagnating,
  };
}
