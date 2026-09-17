import { prisma } from './db.js';
import { addDays } from './dateUtils.js';
import type { MealItem } from './meals.js';

export interface JournalMealEntry {
  id: string;
  time: string;
  rawDescription: string;
  itemsSummary: string;
  kcalLow: number;
  kcalMid: number;
  kcalHigh: number;
  inputType: string;
}

// A single logical meal can be split across several DB rows when Claude resolves it in batches
// across a clarification back-and-forth (see lib/meals.ts) — each row's `items` only ever holds
// what was actually counted in ITS kcal figures, but `rawDescription` is the model's free-text
// description of the meal as it understood it at that point in the conversation, which can
// mention foods that ended up counted in a *different* row (still ambiguous at the time). Showing
// rawDescription next to that row's kcal makes it look like those foods were double-counted, so
// the dashboard shows this items-derived summary instead — it always matches the row's own kcal.
function summarizeItems(items: MealItem[]): string {
  return items.map((item) => `${Math.round(item.estimatedGrams)}g ${item.name}`).join(', ');
}

export interface JournalActivityEntry {
  id: string;
  time: string;
  description: string;
  sportType: string;
  reportedCalories: number;
  relationToPlan: string;
  baselineKcal: number;
  rawDiffKcal: number;
  intensity: string | null;
  durationMinutes: number | null;
  estimationMethod: string | null;
  bonusKcal: number;
  status: string;
  routineId: string | null;
}

export interface DailyJournal {
  date: string;
  meals: JournalMealEntry[];
  activities: JournalActivityEntry[];
  weightKg: number | null;
  sleepQuality: string | null;
}

export async function getDailyJournal(date: string): Promise<DailyJournal> {
  const dayStart = new Date(`${date}T00:00:00Z`);
  const dayEndExclusive = new Date(`${addDays(date, 1)}T00:00:00Z`);

  const [meals, activities, weight, sleep] = await Promise.all([
    prisma.meal.findMany({ where: { datetime: { gte: dayStart, lt: dayEndExclusive } }, orderBy: { datetime: 'asc' } }),
    prisma.activityLog.findMany({ where: { date }, orderBy: { createdAt: 'asc' } }),
    prisma.weight.findUnique({ where: { date } }),
    prisma.sleepLog.findUnique({ where: { date } }),
  ]);

  return {
    date,
    meals: meals.map((meal) => ({
      id: meal.id,
      time: meal.datetime.toISOString().slice(11, 16),
      rawDescription: meal.rawDescription,
      itemsSummary: summarizeItems(meal.items as unknown as MealItem[]),
      kcalLow: meal.kcalLow,
      kcalMid: meal.kcalMid,
      kcalHigh: meal.kcalHigh,
      inputType: meal.inputType,
    })),
    activities: activities.map((activity) => ({
      id: activity.id,
      time: activity.createdAt.toISOString().slice(11, 16),
      description: activity.description,
      sportType: activity.sportType,
      reportedCalories: activity.reportedCalories,
      relationToPlan: activity.relationToPlan,
      baselineKcal: activity.baselineKcal,
      rawDiffKcal: activity.rawDiffKcal,
      intensity: activity.intensity ?? null,
      durationMinutes: activity.durationMinutes ?? null,
      estimationMethod: activity.estimationMethod ?? null,
      bonusKcal: activity.bonusKcal,
      status: activity.status,
      routineId: activity.routineId ?? null,
    })),
    weightKg: weight?.weightKg ?? null,
    sleepQuality: sleep?.quality ?? null,
  };
}
