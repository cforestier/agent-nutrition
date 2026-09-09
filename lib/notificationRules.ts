import type { Weekday } from './weeklySchedule.js';

export interface NotificationContext {
  dateIso: string;
  hourLocal: number;
  weekday: Weekday;
  weighInDay: string | null;
  reviewDay: string | null;
  todayWeightLogged: boolean;
  latestMealAgeHours: number | null;
  todayDayPlanConfirmed: boolean;
  todayWeekdayActivityHint: string | null;
  latestDailyState: {
    date: string;
    observedTdee: number | null;
    predictedTdee: number | null;
    targetKcal: number | null;
    adherenceFlag: boolean | null;
    dietBreakRecommended: boolean;
  } | null;
  currentTargetKcal: number | null;
}

export interface NotificationRuleResult {
  rule: string;
  message: string;
}

const MORNING_START_HOUR = 7;
const MORNING_END_HOUR = 11;
const EVENING_START_HOUR = 18;
const EVENING_END_HOUR = 22;
const STALE_MEAL_HOURS = 24;

function isMorning(hourLocal: number): boolean {
  return hourLocal >= MORNING_START_HOUR && hourLocal < MORNING_END_HOUR;
}

function isEvening(hourLocal: number): boolean {
  return hourLocal >= EVENING_START_HOUR && hourLocal < EVENING_END_HOUR;
}

export function ruleNoMealIn24h(ctx: NotificationContext): NotificationRuleResult | null {
  if (ctx.latestMealAgeHours === null || ctx.latestMealAgeHours > STALE_MEAL_HOURS) {
    return {
      rule: 'no_meal_24h',
      message: 'Pas de repas noté depuis plus de 24h — pense à enregistrer ce que tu manges quand tu peux.',
    };
  }
  return null;
}

export function ruleWeeklyWeighIn(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isMorning(ctx.hourLocal)) return null;
  if (ctx.weighInDay !== ctx.weekday) return null;
  if (ctx.todayWeightLogged) return null;
  return {
    rule: 'weekly_weigh_in',
    message:
      "C'est le jour de pesée. Pèse-toi à jeun, après être passé aux toilettes, avant de boire quoi que ce soit, puis note le résultat.",
  };
}

export function ruleDayPlanPrompt(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isMorning(ctx.hourLocal)) return null;
  if (ctx.todayDayPlanConfirmed) return null;
  const hint = ctx.todayWeekdayActivityHint ? ` (probablement : ${ctx.todayWeekdayActivityHint})` : '';
  return {
    rule: 'day_plan_prompt',
    message: `Qu'est-ce que tu as prévu aujourd'hui ?${hint}`,
  };
}

export function ruleWeeklyReview(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isEvening(ctx.hourLocal)) return null;
  if (ctx.reviewDay !== ctx.weekday) return null;
  if (!ctx.latestDailyState || ctx.latestDailyState.observedTdee === null) return null;

  const s = ctx.latestDailyState;
  const adherenceText =
    s.adherenceFlag === true ? 'dans la tolérance' : s.adherenceFlag === false ? 'hors tolérance' : 'pas encore évalué';
  const parts = [
    `Bilan de la semaine : TDEE observé ${s.observedTdee?.toFixed(0)} kcal`,
    s.predictedTdee !== null ? `vs prédit ${s.predictedTdee.toFixed(0)} kcal` : null,
    `cible actuelle ${s.targetKcal?.toFixed(0)} kcal`,
    `ajustement ${adherenceText}.`,
  ].filter((part): part is string => part !== null);

  return { rule: 'weekly_review', message: parts.join(', ') };
}

export function ruleDietBreak(ctx: NotificationContext): NotificationRuleResult | null {
  if (!ctx.latestDailyState?.dietBreakRecommended) return null;
  return {
    rule: 'diet_break',
    message:
      'Palier haut proposé : on remonte à maintenance pour 7 jours, pas de baisse supplémentaire. Le poids peut remonter de 1 à 2 kg (glycogène et eau, pas de la graisse) et redescend en quelques jours.',
  };
}

export const NOTIFICATION_RULES = [
  ruleDayPlanPrompt,
  ruleWeeklyWeighIn,
  ruleWeeklyReview,
  ruleDietBreak,
  ruleNoMealIn24h,
];
