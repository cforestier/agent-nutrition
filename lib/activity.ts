import { prisma } from './db.js';
import { weekdayOf, todayIsoDate } from './dateUtils.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import { getProfileSnapshot } from './profile.js';
import type { ToolDefinition } from './claude.js';

export type SportType = 'cycling' | 'running' | 'strength' | 'crossfit' | 'walking' | 'other';
export type Intensity = 'light' | 'moderate' | 'sustained' | 'vigorous' | 'maximal';

export const SPORT_DISCOUNTS: Record<SportType, number> = {
  cycling: 0.2,
  running: 0.25,
  strength: 0.3,
  crossfit: 0.3,
  walking: 0.35,
  other: 0.35,
};

// MET (Metabolic Equivalent of Task) values per activity x intensity, used to estimate
// calorie expenditure from duration when no device measurement is available. Only sports
// with a documented reference are covered; strength/other still require reportedCalories.
const MET_TABLE: Partial<Record<SportType, Record<Intensity, number>>> = {
  cycling: { light: 4.0, moderate: 6.8, sustained: 8.0, vigorous: 10.0, maximal: 12.0 },
  running: { light: 6.0, moderate: 9.8, sustained: 11.0, vigorous: 12.8, maximal: 16.0 },
  crossfit: { light: 3.5, moderate: 7.0, sustained: 8.0, vigorous: 10.0, maximal: 12.0 },
  walking: { light: 2.8, moderate: 3.5, sustained: 4.3, vigorous: 5.0, maximal: 6.0 },
};

export function lookupMet(sportType: SportType, intensity: Intensity): number | undefined {
  return MET_TABLE[sportType]?.[intensity];
}

export function metToKcal(met: number, durationMinutes: number, weightKg: number): number {
  return Math.round(((met * 3.5 * weightKg) / 200) * durationMinutes);
}

// `isAtypical` is deliberately NOT written here: it is owned exclusively by `apply_day_plan`
// (user/scenario intent). It drives `excludeAtypical` in the 14-day rolling intake average that
// feeds the observed-TDEE adaptation loop, so deriving it from activity bonuses would silently
// drop every recurring-routine day out of that average.
// Cancelled/superseded rows are filtered in JS rather than in the query on purpose: legacy
// documents predating the `status` field physically lack it in MongoDB, so any
// `where: { status: ... }` clause silently drops them (verified empirically), whereas Prisma
// applies the schema default on read — so post-filtering counts them, correctly, as active.
// `superseded` marks a routine's morning estimate once the real occurrence has been confirmed
// (see `handleApplyActivityRoutineTool`): it stays in the journal for comparison but must not
// double-count its bonus alongside the real `done` row it was replaced by.
const EXCLUDED_FROM_BONUS_STATUSES = new Set(['cancelled', 'superseded']);

export async function recomputeEventBonusForDate(date: string): Promise<void> {
  const logs = await prisma.activityLog.findMany({ where: { date } });
  const total = logs.reduce((sum, log) => sum + (EXCLUDED_FROM_BONUS_STATUSES.has(log.status) ? 0 : log.bonusKcal), 0);
  await prisma.dayPlan.upsert({
    where: { date },
    create: { date, scenariosApplied: [], segmentsResolved: [], eventBonusKcal: total },
    update: { eventBonusKcal: total },
  });
}

const MATERIALITY_THRESHOLD_KCAL = 100;

export interface LogActivityInput {
  date: string;
  description: string;
  sportType: SportType;
  reportedCalories?: number;
  durationMinutes?: number;
  intensity?: Intensity;
  relationToPlan: 'replaces' | 'additional';
  status?: 'done' | 'planned';
  plannedTime?: string;
}

export const LOG_ACTIVITY_TOOL: ToolDefinition = {
  name: 'log_activity',
  description:
    "Enregistre une activité physique rapportée par l'utilisateur. Deux façons de fournir la dépense calorique : " +
    "(1) reportedCalories si l'utilisateur a une valeur de sa montre/tracker — à privilégier quand elle est disponible ; " +
    "(2) durationMinutes + intensity sinon, pour estimer la dépense via une table MET (uniquement disponible pour cycling/running/crossfit/walking). " +
    "Si l'utilisateur décrit une activité sans donnée de montre, demande-lui explicitement la durée ET l'intensité ressentie " +
    "(light = léger, moderate = modéré, sustained = soutenu, vigorous = vigoureux, maximal = maximal) avant d'appeler cet outil — ne devine jamais l'intensité. " +
    "Si l'utilisateur ne précise pas si cette activité REMPLACE l'activité initialement prévue pour la journée ou si elle est EN PLUS, " +
    "demande-le lui explicitement avant d'appeler cet outil — ne suppose jamais. " +
    "Si l'activité correspond à une routine déjà définie (voir la liste des routines connues), utilise plutôt apply_activity_routine — " +
    "n'utilise log_activity que pour une activité isolée, hors routine, sinon la même occurrence serait comptée deux fois.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      description: { type: 'string' },
      sportType: { type: 'string', enum: ['cycling', 'running', 'strength', 'crossfit', 'walking', 'other'] },
      reportedCalories: { type: 'number', description: "Calories affichées par la montre/tracker, si disponibles." },
      durationMinutes: { type: 'number', description: "Durée de l'activité en minutes, si pas de donnée de montre." },
      intensity: {
        type: 'string',
        enum: ['light', 'moderate', 'sustained', 'vigorous', 'maximal'],
        description: "Intensité ressentie, si pas de donnée de montre.",
      },
      relationToPlan: { type: 'string', enum: ['replaces', 'additional'] },
      status: { type: 'string', enum: ['done', 'planned'], description: "'planned' si l'activité n'a pas encore eu lieu, annoncée à l'avance" },
      plannedTime: { type: 'string', description: "HH:MM, requis quand status = 'planned'" },
    },
    required: ['date', 'description', 'sportType', 'relationToPlan'],
  },
};

export async function handleLogActivityTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogActivityInput;
  const status = input.status ?? 'done';

  // A `done` activity already happened, so it can't be dated after today — catches the model
  // miscalculating "today" (e.g. logging tomorrow's date for something the user just did).
  if (status === 'done' && input.date > todayIsoDate()) {
    return `La date ${input.date} est dans le futur alors que le statut est 'done' (activité déjà réalisée) — vérifie la date du jour donnée dans le prompt système et corrige-la avant de réessayer, sauf si l'utilisateur a explicitement précisé une autre date.`;
  }

  const hasDeviceCalories = input.reportedCalories !== undefined;
  const hasDurationAndIntensity = input.durationMinutes !== undefined && input.intensity !== undefined;

  if (!hasDeviceCalories && !hasDurationAndIntensity) {
    return "Il manque soit les calories affichées par la montre, soit la durée ET l'intensité de l'activité pour estimer la dépense — demande l'info manquante à l'utilisateur avant de rappeler cet outil.";
  }

  const profile = await getProfileSnapshot();

  let reportedCalories: number;
  let estimationMethod: 'device' | 'met_estimate';
  let metUsed: number | null = null;

  if (hasDeviceCalories) {
    reportedCalories = input.reportedCalories as number;
    estimationMethod = 'device';
  } else {
    if (profile.weightKg === null) {
      return "Le poids actuel de l'utilisateur n'est pas encore connu, nécessaire pour estimer la dépense calorique à partir de la durée et de l'intensité. Demande-lui son poids avant de continuer.";
    }
    const met = lookupMet(input.sportType, input.intensity as Intensity);
    if (met === undefined) {
      return `Aucune table d'estimation calorique n'existe pour le type d'activité "${input.sportType}" — demande à l'utilisateur les calories affichées par sa montre/tracker pour cette activité.`;
    }
    reportedCalories = metToKcal(met, input.durationMinutes as number, profile.weightKg);
    estimationMethod = 'met_estimate';
    metUsed = met;
  }

  const weeklyDefault = await getWeeklyDefault(weekdayOf(input.date));
  const baselineKcal = weeklyDefault?.avgKcal ?? 0;

  const rawDiffKcal = input.relationToPlan === 'replaces' ? reportedCalories - baselineKcal : reportedCalories;

  const discountPct = SPORT_DISCOUNTS[input.sportType];
  const adjustedDiffKcal = rawDiffKcal * (1 - discountPct);
  const bonusKcal = Math.abs(adjustedDiffKcal) >= MATERIALITY_THRESHOLD_KCAL ? adjustedDiffKcal : 0;

  const existingPlanned = await prisma.activityLog.findFirst({
    where: { date: input.date, sportType: input.sportType, routineId: null, status: 'planned' },
  });

  const activityData = {
    date: input.date,
    description: input.description,
    sportType: input.sportType,
    reportedCalories,
    relationToPlan: input.relationToPlan,
    baselineKcal,
    rawDiffKcal,
    discountPct,
    bonusKcal,
    intensity: input.intensity,
    durationMinutes: input.durationMinutes,
    estimationMethod,
    metUsed: metUsed ?? undefined,
    status,
    plannedTime: input.plannedTime,
    routineId: null,
  };

  if (existingPlanned) {
    await prisma.activityLog.update({ where: { id: existingPlanned.id }, data: activityData });
  } else {
    await prisma.activityLog.create({ data: activityData });
  }

  await recomputeEventBonusForDate(input.date);

  const calorieNote = estimationMethod === 'met_estimate' ? `${reportedCalories} kcal estimées` : `${reportedCalories} kcal`;

  if (bonusKcal === 0) {
    return `Activité enregistrée (${input.description}, ${calorieNote}). Écart avec le prévu trop faible (moins de ${MATERIALITY_THRESHOLD_KCAL} kcal après rabais) pour ajuster ta cible — considérée comme normale.`;
  }

  const sign = bonusKcal > 0 ? '+' : '';
  const newTargetNote =
    profile.currentTargetKcal !== null ? ` → ${(profile.currentTargetKcal + bonusKcal).toFixed(0)} kcal aujourd'hui` : '';

  return `Activité enregistrée (${input.description}, ${calorieNote}, rabais ${(discountPct * 100).toFixed(0)}%). Cible du jour ajustée de ${sign}${bonusKcal.toFixed(0)} kcal${newTargetNote}.`;
}
