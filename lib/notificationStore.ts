import { prisma } from './db.js';

export async function countNotificationsToday(date: string): Promise<number> {
  return prisma.notification.count({ where: { date } });
}

export async function hasRuleFiredToday(date: string, rule: string): Promise<boolean> {
  const existing = await prisma.notification.findUnique({ where: { date_rule: { date, rule } } });
  return existing !== null;
}

export async function recordNotificationSent(date: string, rule: string): Promise<void> {
  await prisma.notification.create({ data: { date, rule } });
}

export interface RecentMeal {
  datetime: Date;
}

export async function getMostRecentMeal(): Promise<RecentMeal | null> {
  const meal = await prisma.meal.findFirst({ orderBy: { datetime: 'desc' } });
  return meal ? { datetime: meal.datetime } : null;
}

export interface RecentDailyState {
  date: string;
  observedTdee: number | null;
  predictedTdee: number | null;
  targetKcal: number | null;
  adherenceFlag: boolean | null;
  dietBreakRecommended: boolean;
}

export async function getMostRecentDailyState(): Promise<RecentDailyState | null> {
  const state = await prisma.dailyState.findFirst({ orderBy: { date: 'desc' } });
  return state
    ? {
        date: state.date,
        observedTdee: state.observedTdee,
        predictedTdee: state.predictedTdee,
        targetKcal: state.targetKcal,
        adherenceFlag: state.adherenceFlag,
        dietBreakRecommended: state.dietBreakRecommended,
      }
    : null;
}
