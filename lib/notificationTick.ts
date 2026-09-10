import { prisma } from './db.js';
import { sendMessage, sendMessageWithKeyboard } from './telegram.js';
import { weekdayOf } from './dateUtils.js';
import { getProfileSnapshot } from './profile.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import { recentSleepQualities } from './sleep.js';
import { proteinTargetRangeG } from './calc/baseline.js';
import {
  countNotificationsToday,
  hasRuleFiredToday,
  recordNotificationSent,
  getMostRecentMeal,
  getMostRecentDailyState,
  getRecentDailyStates,
} from './notificationStore.js';
import { NOTIFICATION_RULES } from './notificationRules.js';
import type { NotificationContext, WeeklyMacros } from './notificationRules.js';

const MAX_NOTIFICATIONS_PER_DAY = 4;
const QUIET_HOUR_START = 22;
const QUIET_HOUR_END = 7;
const ZURICH_TZ = 'Europe/Zurich';
const WEEKLY_WINDOW_DAYS = 7;

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

  const [profile, weeklyDefault, todayWeight, todayDayPlan, latestMeal, latestDailyState, recentDailyStates, sleepQualities] =
    await Promise.all([
      getProfileSnapshot(),
      getWeeklyDefault(weekday),
      prisma.weight.findUnique({ where: { date: dateIso } }),
      prisma.dayPlan.findUnique({ where: { date: dateIso } }),
      getMostRecentMeal(),
      getMostRecentDailyState(),
      getRecentDailyStates(WEEKLY_WINDOW_DAYS),
      recentSleepQualities(WEEKLY_WINDOW_DAYS),
    ]);

  const latestMealAgeHours = latestMeal ? (now.getTime() - latestMeal.datetime.getTime()) / (1000 * 60 * 60) : null;

  const proteinTarget = profile.weightKg !== null ? proteinTargetRangeG(profile.weightKg) : null;
  const weeklyMacros: WeeklyMacros | null = proteinTarget
    ? { entries: recentDailyStates, proteinTargetMinG: proteinTarget.minG, proteinTargetMaxG: proteinTarget.maxG }
    : null;

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
    weeklyMacros,
    recentSleepQualities: sleepQualities,
  };

  const sent: { rule: string; message: string }[] = [];

  for (const rule of NOTIFICATION_RULES) {
    if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) break;
    const result = await rule(context);
    if (!result) continue;
    if (await hasRuleFiredToday(dateIso, result.rule)) continue;

    if (result.buttons) {
      await sendMessageWithKeyboard(chatId, result.message, result.buttons);
    } else {
      await sendMessage(chatId, result.message);
    }
    await recordNotificationSent(dateIso, result.rule);
    sent.push(result);
    sentCount++;
  }

  return { sent, skippedQuietHours: false };
}
