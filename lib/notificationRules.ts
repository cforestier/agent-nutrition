import type { Weekday } from './weeklySchedule.js';
import type { InlineKeyboardButton } from './telegram.js';
import type { SleepQuality } from './calc/baseline.js';
import { converse } from './claude.js';

export interface WeeklyMacros {
  entries: { date: string; totalKcal: number; proteinG: number; carbsG: number; fatG: number }[];
  proteinTargetMinG: number;
  proteinTargetMaxG: number;
}

export interface UpcomingActivity {
  id: string;
  description: string;
  hoursUntil: number;
  durationMinutes: number | null;
}

export interface RecentDoneActivity {
  id: string;
  description: string;
  hoursAgo: number;
}

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
  weeklyMacros: WeeklyMacros | null;
  recentSleepQualities: SleepQuality[];
  weightKg: number | null;
  todayCarbsG: number;
  // The single soonest/most-recent qualifying (long/intense) activity, already filtered and
  // window-checked by runNotificationTick — see PRE_EFFORT_WINDOW_HOURS / POST_EFFORT_WINDOW_HOURS
  // there. null means no such activity is upcoming/recent right now.
  upcomingActivity: UpcomingActivity | null;
  recentDoneActivity: RecentDoneActivity | null;
}

export interface NotificationRuleResult {
  rule: string;
  message: string;
  buttons?: InlineKeyboardButton[];
}

export type NotificationRule = (
  ctx: NotificationContext
) => NotificationRuleResult | null | Promise<NotificationRuleResult | null>;

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
    message: `Qu'est-ce que tu as prévu aujourd'hui ?${hint}\n\nNuit ?`,
    buttons: [
      { text: 'Bonne', callback_data: 'sleep:good' },
      { text: 'Moyenne', callback_data: 'sleep:medium' },
      { text: 'Mauvaise', callback_data: 'sleep:bad' },
    ],
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

const MIN_WEEKLY_ENTRIES = 3;

const WEEKLY_MACRO_INSIGHT_PROMPT = `Tu es l'assistant nutrition de Raphaël, athlète d'endurance en volume élevé.
On te donne un résumé factuel d'une semaine : macros moyennes (protéines/glucides/lipides), la cible protéines, le pourcentage de calories venant des glucides et des lipides, et la répartition de la qualité du sommeil.
Rédige UNE seule observation courte (2 à 3 phrases maximum), factuelle et bienveillante, qui relie ces signaux entre eux si c'est pertinent (par exemple fatigue et apport en lipides ou en protéines bas).
N'invente aucune cible chiffrée pour les glucides ou les lipides — utilise ton jugement nutritionnel général pour dire si quelque chose semble déséquilibré, sans ton moralisateur.
Si tout semble équilibré, dis-le simplement.`;

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function ruleWeeklyMacroInsight(ctx: NotificationContext): Promise<NotificationRuleResult | null> {
  if (!isEvening(ctx.hourLocal)) return null;
  if (ctx.reviewDay !== ctx.weekday) return null;
  if (!ctx.weeklyMacros || ctx.weeklyMacros.entries.length < MIN_WEEKLY_ENTRIES) return null;

  const { entries, proteinTargetMinG, proteinTargetMaxG } = ctx.weeklyMacros;
  const avgProtein = average(entries.map((e) => e.proteinG));
  const avgCarbs = average(entries.map((e) => e.carbsG));
  const avgFat = average(entries.map((e) => e.fatG));
  const avgKcal = average(entries.map((e) => e.totalKcal));
  const carbsPctKcal = avgKcal > 0 ? ((avgCarbs * 4) / avgKcal) * 100 : 0;
  const fatPctKcal = avgKcal > 0 ? ((avgFat * 9) / avgKcal) * 100 : 0;

  const sleepCounts = { good: 0, medium: 0, bad: 0 };
  for (const quality of ctx.recentSleepQualities) sleepCounts[quality]++;

  const summary = [
    `Semaine (${entries.length} jours de données) :`,
    `protéines moy. ${avgProtein.toFixed(0)} g/j (cible ${proteinTargetMinG.toFixed(0)}-${proteinTargetMaxG.toFixed(0)} g/j)`,
    `glucides moy. ${avgCarbs.toFixed(0)} g/j (${carbsPctKcal.toFixed(0)}% des calories)`,
    `lipides moy. ${avgFat.toFixed(0)} g/j (${fatPctKcal.toFixed(0)}% des calories)`,
    `calories moy. ${avgKcal.toFixed(0)} kcal/j`,
    `sommeil : ${sleepCounts.good} bonnes, ${sleepCounts.medium} moyennes, ${sleepCounts.bad} mauvaises nuits sur ${ctx.recentSleepQualities.length} nuits notées`,
  ].join(', ');

  const result = await converse(WEEKLY_MACRO_INSIGHT_PROMPT, [{ role: 'user', content: summary }]);

  return { rule: 'weekly_macro_insight', message: result.text };
}

export function ruleDietBreak(ctx: NotificationContext): NotificationRuleResult | null {
  if (!ctx.latestDailyState?.dietBreakRecommended) return null;
  return {
    rule: 'diet_break',
    message:
      'Palier haut proposé : on remonte à maintenance pour 7 jours, pas de baisse supplémentaire. Le poids peut remonter de 1 à 2 kg (glycogène et eau, pas de la graisse) et redescend en quelques jours.',
  };
}

// Conservative low end of the ~1-4 g/kg/h pre-endurance-exercise carb intake range (ACSM/ISSN
// guidance). Collapsed into a same-day floor rather than an hours-before window because meal
// timing isn't tracked precisely enough to compute the real windowed figure.
const PRE_EFFORT_CARB_FLOOR_G_PER_KG = 1;
const PRE_EFFORT_STALE_MEAL_HOURS = 4;

// Rough intra-exercise carb-intake tiers (Jeukendrup-style guidance): negligible under an hour,
// scaling up to ~90g/h once a session gets long enough that a single pre-loaded meal can't cover
// it. Duration-gated rather than a flat number since the need scales with time, not with intensity.
function intraEffortCarbsPerHour(durationMinutes: number): number | null {
  if (durationMinutes < 60) return null;
  if (durationMinutes < 150) return 30;
  if (durationMinutes < 180) return 60;
  return 90;
}

export function ruleFuelBeforeActivity(ctx: NotificationContext): NotificationRuleResult | null {
  if (!ctx.upcomingActivity) return null;

  const carbsFloorG = ctx.weightKg !== null ? PRE_EFFORT_CARB_FLOOR_G_PER_KG * ctx.weightKg : null;
  const carbsLow = carbsFloorG !== null && ctx.todayCarbsG < carbsFloorG;
  const mealStale = ctx.latestMealAgeHours === null || ctx.latestMealAgeHours >= PRE_EFFORT_STALE_MEAL_HOURS;
  const { id, description, hoursUntil, durationMinutes } = ctx.upcomingActivity;
  const intraCarbsPerHour = durationMinutes !== null ? intraEffortCarbsPerHour(durationMinutes) : null;
  // Intra-effort need depends on duration alone, not on today's pre-effort fueling signals — a
  // long session with fine pre-effort carbs still deserves the "eat during" reminder, which the
  // carbsLow/mealStale-only condition used to miss entirely.
  if (!carbsLow && !mealStale && intraCarbsPerHour === null) return null;

  const inLabel = hoursUntil < 1 ? "moins d'une heure" : `${Math.round(hoursUntil)}h`;

  // Both pre-effort signals often co-occur (skipping meals means skipping carbs too) — merged into
  // one message instead of two separate rules so they don't fire as redundant back-to-back alerts.
  const signals: string[] = [];
  if (mealStale) {
    signals.push(
      ctx.latestMealAgeHours === null ? "aucun repas noté aujourd'hui" : `pas de repas depuis ${Math.round(ctx.latestMealAgeHours)}h`
    );
  }
  if (carbsLow) {
    signals.push(`glucides bas (${Math.round(ctx.todayCarbsG)}g, repère ~${(carbsFloorG as number).toFixed(0)}g avant une sortie longue/intense)`);
  }

  const parts: string[] = [
    signals.length > 0
      ? `Tu as "${description}" prévu dans ${inLabel} — ${signals.join(' et ')}. Pense à manger un peu avant pour ne pas partir à sec.`
      : `Tu as "${description}" prévu dans ${inLabel}.`,
  ];
  if (intraCarbsPerHour !== null) {
    parts.push(`Vu la durée prévue (${Math.round(durationMinutes as number)} min), pense aussi à ~${intraCarbsPerHour}g de glucides/h pendant l'effort.`);
  }

  return {
    rule: `fuel_pre_effort:${id}`,
    message: parts.join(' '),
  };
}

export function ruleRefuelAfterActivity(ctx: NotificationContext): NotificationRuleResult | null {
  if (!ctx.recentDoneActivity) return null;
  const { id, description, hoursAgo } = ctx.recentDoneActivity;
  return {
    rule: `refuel_post_effort:${id}`,
    message: `"${description}" terminé il y a ${Math.round(hoursAgo)}h, sans repas noté depuis — pense à manger (glucides + protéines) pour la récup, surtout après une séance de ce volume.`,
  };
}

export const NOTIFICATION_RULES: NotificationRule[] = [
  ruleDayPlanPrompt,
  ruleWeeklyWeighIn,
  ruleWeeklyReview,
  ruleWeeklyMacroInsight,
  ruleDietBreak,
  ruleFuelBeforeActivity,
  ruleRefuelAfterActivity,
  ruleNoMealIn24h,
];
