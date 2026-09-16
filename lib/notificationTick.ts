import { prisma } from './db.js';
import { sendMessage, sendMessageWithKeyboard } from './telegram.js';
import { weekdayOf } from './dateUtils.js';
import { getProfileSnapshot } from './profile.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import { recentSleepQualities } from './sleep.js';
import { proteinTargetRangeG } from './calc/baseline.js';
import { getTodaySummary } from './todaySummary.js';
import {
  countNotificationsToday,
  hasRuleFiredToday,
  recordNotificationSent,
  getMostRecentMeal,
  getMostRecentDailyState,
  getRecentDailyStates,
} from './notificationStore.js';
import { NOTIFICATION_RULES } from './notificationRules.js';
import type { NotificationContext, WeeklyMacros, UpcomingActivity, RecentDoneActivity } from './notificationRules.js';
import { getDueRoutinesToday, autoApplyRoutineForToday } from './activityRoutine.js';

const MAX_NOTIFICATIONS_PER_DAY = 4;
const QUIET_HOUR_START = 22;
const QUIET_HOUR_END = 7;
const ZURICH_TZ = 'Europe/Zurich';
const WEEKLY_WINDOW_DAYS = 7;

// Only a long/intense session is worth a fueling alert — a 20-minute easy jog doesn't warrant one.
const SIGNIFICANT_DURATION_MINUTES = 60;
const SIGNIFICANT_KCAL = 400;
const PRE_EFFORT_WINDOW_HOURS = 3;
const POST_EFFORT_WINDOW_HOURS = 3;

function zurichParts(now: Date): { dateIso: string; hourLocal: number; minuteLocal: number } {
  const dateIso = now.toLocaleDateString('en-CA', { timeZone: ZURICH_TZ });
  const hourLocal = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: ZURICH_TZ }));
  const minuteLocal = Number(now.toLocaleString('en-US', { minute: 'numeric', timeZone: ZURICH_TZ }));
  return { dateIso, hourLocal, minuteLocal };
}

function isSignificantEffort(activity: { durationMinutes: number | null; reportedCalories: number }): boolean {
  return (activity.durationMinutes ?? 0) >= SIGNIFICANT_DURATION_MINUTES || activity.reportedCalories >= SIGNIFICANT_KCAL;
}

// plannedTime is meant to be HH:MM (see log_activity's tool schema) but isn't validated against
// that pattern when the model writes it, so a stray non-conforming value (e.g. "midi") must be
// skipped rather than crash the tick.
function parseHHMMToMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function selectUpcomingActivity(
  activities: { id: string; description: string; status: string; plannedTime: string | null; durationMinutes: number | null; reportedCalories: number }[],
  nowMinutesLocal: number
): UpcomingActivity | null {
  let best: UpcomingActivity | null = null;
  for (const activity of activities) {
    if (activity.status !== 'planned' || !isSignificantEffort(activity)) continue;
    const plannedMinutes = parseHHMMToMinutes(activity.plannedTime);
    if (plannedMinutes === null) continue;
    const deltaMinutes = plannedMinutes - nowMinutesLocal;
    if (deltaMinutes <= 0 || deltaMinutes > PRE_EFFORT_WINDOW_HOURS * 60) continue;
    if (!best || deltaMinutes < best.hoursUntil * 60) {
      best = { id: activity.id, description: activity.description, hoursUntil: deltaMinutes / 60, durationMinutes: activity.durationMinutes };
    }
  }
  return best;
}

function selectRecentDoneActivity(
  activities: { id: string; description: string; status: string; createdAt: Date; durationMinutes: number | null; reportedCalories: number }[],
  now: Date,
  latestMealDatetime: Date | null
): RecentDoneActivity | null {
  let best: RecentDoneActivity | null = null;
  for (const activity of activities) {
    if (activity.status !== 'done' || !isSignificantEffort(activity)) continue;
    const hoursAgo = (now.getTime() - activity.createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 0 || hoursAgo > POST_EFFORT_WINDOW_HOURS) continue;
    if (latestMealDatetime !== null && latestMealDatetime.getTime() >= activity.createdAt.getTime()) continue;
    if (!best || hoursAgo < best.hoursAgo) {
      best = { id: activity.id, description: activity.description, hoursAgo };
    }
  }
  return best;
}

export interface TickResult {
  sent: { rule: string; message: string }[];
  skippedQuietHours: boolean;
}

export async function runNotificationTick(now: Date, chatId: number): Promise<TickResult> {
  const { dateIso, hourLocal, minuteLocal } = zurichParts(now);

  if (hourLocal >= QUIET_HOUR_START || hourLocal < QUIET_HOUR_END) {
    return { sent: [], skippedQuietHours: true };
  }

  let sentCount = await countNotificationsToday(dateIso);
  if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) {
    return { sent: [], skippedQuietHours: false };
  }

  const weekday = weekdayOf(dateIso);
  const sent: { rule: string; message: string }[] = [];

  const dueRoutines = await getDueRoutinesToday(weekday, dateIso);
  if (dueRoutines.length > 0 && sentCount < MAX_NOTIFICATIONS_PER_DAY) {
    const routine = dueRoutines[0];
    const { activityLogId, message } = await autoApplyRoutineForToday(routine, dateIso);
    await sendMessageWithKeyboard(chatId, message, [
      { text: 'Confirmer', callback_data: `routine:confirm:${activityLogId}` },
      { text: "Pas aujourd'hui", callback_data: `routine:cancel:${activityLogId}` },
    ]);
    const rule = `routine_auto_apply:${routine.id}`;
    await recordNotificationSent(dateIso, rule);
    sent.push({ rule, message });
    sentCount++;
  }

  const [
    profile,
    weeklyDefault,
    todayWeight,
    todayDayPlan,
    latestMeal,
    latestDailyState,
    recentDailyStates,
    sleepQualities,
    todaysActivities,
    todaySummary,
  ] = await Promise.all([
    getProfileSnapshot(),
    getWeeklyDefault(weekday),
    prisma.weight.findUnique({ where: { date: dateIso } }),
    prisma.dayPlan.findUnique({ where: { date: dateIso } }),
    getMostRecentMeal(),
    getMostRecentDailyState(),
    getRecentDailyStates(WEEKLY_WINDOW_DAYS),
    recentSleepQualities(WEEKLY_WINDOW_DAYS),
    prisma.activityLog.findMany({ where: { date: dateIso } }),
    getTodaySummary(dateIso),
  ]);

  const latestMealAgeHours = latestMeal ? (now.getTime() - latestMeal.datetime.getTime()) / (1000 * 60 * 60) : null;

  const proteinTarget = profile.weightKg !== null ? proteinTargetRangeG(profile.weightKg) : null;
  const weeklyMacros: WeeklyMacros | null = proteinTarget
    ? { entries: recentDailyStates, proteinTargetMinG: proteinTarget.minG, proteinTargetMaxG: proteinTarget.maxG }
    : null;

  const upcomingActivity = selectUpcomingActivity(todaysActivities, hourLocal * 60 + minuteLocal);
  const recentDoneActivity = selectRecentDoneActivity(todaysActivities, now, latestMeal?.datetime ?? null);

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
    weightKg: profile.weightKg,
    todayCarbsG: todaySummary.carbsG,
    upcomingActivity,
    recentDoneActivity,
  };

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
