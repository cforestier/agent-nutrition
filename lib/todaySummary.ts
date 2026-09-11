import { prisma } from './db.js';
import { addDays } from './dateUtils.js';
import { getProfileSnapshot } from './profile.js';
import { proteinTargetRangeG } from './calc/baseline.js';
import type { MealItem } from './meals.js';

const FAT_TARGET_PCT_OF_KCAL = 0.25;

export interface TodaySummary {
  date: string;
  totalKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  targetKcal: number | null;
  proteinTargetMinG: number | null;
  proteinTargetMaxG: number | null;
  fatTargetG: number | null;
  carbsTargetG: number | null;
}

export async function getTodaySummary(date: string): Promise<TodaySummary> {
  const dayStart = new Date(`${date}T00:00:00Z`);
  const dayEndExclusive = new Date(`${addDays(date, 1)}T00:00:00Z`);

  const [meals, dayPlan, profile] = await Promise.all([
    prisma.meal.findMany({ where: { datetime: { gte: dayStart, lt: dayEndExclusive } } }),
    prisma.dayPlan.findUnique({ where: { date } }),
    getProfileSnapshot(),
  ]);

  let totalKcal = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  for (const meal of meals) {
    totalKcal += meal.kcalMid;
    const items = meal.items as unknown as MealItem[];
    for (const item of items) {
      proteinG += item.proteinG;
      carbsG += item.carbsG;
      fatG += item.fatG;
    }
  }

  const targetKcal =
    profile.currentTargetKcal !== null ? profile.currentTargetKcal + (dayPlan?.eventBonusKcal ?? 0) : null;
  const proteinTarget = profile.weightKg !== null ? proteinTargetRangeG(profile.weightKg) : null;

  const fatTargetG = targetKcal !== null ? (targetKcal * FAT_TARGET_PCT_OF_KCAL) / 9 : null;
  const carbsTargetG =
    targetKcal !== null && proteinTarget !== null && fatTargetG !== null
      ? Math.max(0, (targetKcal - proteinTarget.minG * 4 - fatTargetG * 9) / 4)
      : null;

  return {
    date,
    totalKcal,
    proteinG,
    carbsG,
    fatG,
    targetKcal,
    proteinTargetMinG: proteinTarget?.minG ?? null,
    proteinTargetMaxG: proteinTarget?.maxG ?? null,
    fatTargetG,
    carbsTargetG,
  };
}
