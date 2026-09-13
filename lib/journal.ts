import { prisma } from './db.js';
import { addDays } from './dateUtils.js';

export interface JournalMealEntry {
  id: string;
  time: string;
  rawDescription: string;
  kcalLow: number;
  kcalMid: number;
  kcalHigh: number;
  inputType: string;
}

export interface JournalActivityEntry {
  id: string;
  time: string;
  description: string;
  sportType: string;
  reportedCalories: number;
  relationToPlan: string;
  intensity: string | null;
  durationMinutes: number | null;
  estimationMethod: string | null;
  bonusKcal: number;
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
      intensity: activity.intensity ?? null,
      durationMinutes: activity.durationMinutes ?? null,
      estimationMethod: activity.estimationMethod ?? null,
      bonusKcal: activity.bonusKcal,
    })),
    weightKg: weight?.weightKg ?? null,
    sleepQuality: sleep?.quality ?? null,
  };
}
