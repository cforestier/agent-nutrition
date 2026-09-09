import { prisma } from './db.js';
import { sendMessage } from './telegram.js';
import { weekdayOf } from './dateUtils.js';
import { getProfileSnapshot } from './profile.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import {
  countNotificationsToday,
  hasRuleFiredToday,
  recordNotificationSent,
  getMostRecentMeal,
  getMostRecentDailyState,
} from './notificationStore.js';
import { NOTIFICATION_RULES } from './notificationRules.js';
import type { NotificationContext } from './notificationRules.js';

const MAX_NOTIFICATIONS_PER_DAY = 4;
const QUIET_HOUR_START = 22;
const QUIET_HOUR_END = 7;
const ZURICH_TZ = 'Europe/Zurich';

function zurichParts(now: Date): { dateIso: string; hourLocal: number } {
  const dateIso = now.toLocaleDateString('en-CA', { timeZone: ZURICH_TZ });
  const hourLocal = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: ZURICH_TZ }));
  return { dateIso, hourLocal };
}

export interface TickResult {
  sent: { rule: string; message: string }[];
  skippedQuietHours: boolean;
}

export async function runNotificationTick(now: Date, chatId: number): Promise<TickResult> {
  const { dateIso, hourLocal } = zurichParts(now);

  if (hourLocal >= QUIET_HOUR_START || hourLocal < QUIET_HOUR_END) {
    return { sent: [], skippedQuietHours: true };
  }

  let sentCount = await countNotificationsToday(dateIso);
  if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) {
    return { sent: [], skippedQuietHours: false };
  }

  const weekday = weekdayOf(dateIso);

  const [profile, weeklyDefault, todayWeight, todayDayPlan, latestMeal, latestDailyState] = await Promise.all([
    getProfileSnapshot(),
    getWeeklyDefault(weekday),
    prisma.weight.findUnique({ where: { date: dateIso } }),
    prisma.dayPlan.findUnique({ where: { date: dateIso } }),
    getMostRecentMeal(),
    getMostRecentDailyState(),
  ]);

  const latestMealAgeHours = latestMeal ? (now.getTime() - latestMeal.datetime.getTime()) / (1000 * 60 * 60) : null;

  const context: NotificationContext = {
    dateIso,
    hourLocal,
    weekday,
    weighInDay: profile.weighInDay,
    reviewDay: profile.reviewDay,
    todayWeightLogged: todayWeight !== null,
    latestMealAgeHours,
    todayDayPlanConfirmed: todayDayPlan?.confirmed ?? false,
    todayWeekdayActivityHint: weeklyDefault ? weeklyDefault.activityType : null,
    latestDailyState,
    currentTargetKcal: profile.currentTargetKcal,
  };

  const sent: { rule: string; message: string }[] = [];

  for (const rule of NOTIFICATION_RULES) {
    if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) break;
    const result = rule(context);
    if (!result) continue;
    if (await hasRuleFiredToday(dateIso, result.rule)) continue;

    await sendMessage(chatId, result.message);
    await recordNotificationSent(dateIso, result.rule);
    sent.push(result);
    sentCount++;
  }

  return { sent, skippedQuietHours: false };
}
