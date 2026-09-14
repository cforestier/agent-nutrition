import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { getProfileSnapshot } from './profile.js';
import { lookupMet, metToKcal, SPORT_DISCOUNTS, recomputeEventBonusForDate } from './activity.js';
import type { SportType, Intensity } from './activity.js';
import { WEEKDAYS } from './weeklySchedule.js';
import { todayIsoDate } from './dateUtils.js';
import type { ToolDefinition } from './claude.js';

export interface RoutineLeg {
  sportType: SportType;
  durationMinutes: number;
  intensity: Intensity;
}

const SPORT_TYPE_ENUM = ['cycling', 'running', 'strength', 'crossfit', 'walking', 'other'] as const;
const INTENSITY_ENUM = ['light', 'moderate', 'sustained', 'vigorous', 'maximal'] as const;

export const DEFINE_ACTIVITY_ROUTINE_TOOL: ToolDefinition = {
  name: 'define_activity_routine',
  description:
    "Crée une routine d'activité nommée et réutilisable (ex: \"aller au bureau\"), pas liée à un seul jour de semaine. " +
    "Utilise `legs` si l'utilisateur ne connaît pas le total et décrit chaque étape (sport, durée, intensité) — l'estimation se calcule via une table MET. " +
    "Utilise `estimatedKcal` + `primarySportType` si l'utilisateur connaît déjà le total (montre, historique). " +
    "`recurringWeekdays` : jours de la semaine où cette routine a lieu habituellement, pour qu'elle s'applique automatiquement chaque semaine sans que l'utilisateur ait à le redemander — laisse vide si c'est une routine ponctuelle réutilisable sans jour fixe. " +
    "Demande la tranche horaire (timeRangeStart/End) si l'utilisateur ne l'a pas donnée spontanément. " +
    "N'appelle cet outil qu'après avoir confirmé les détails avec l'utilisateur.",
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      legs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sportType: { type: 'string', enum: [...SPORT_TYPE_ENUM] },
            durationMinutes: { type: 'number' },
            intensity: { type: 'string', enum: [...INTENSITY_ENUM] },
          },
          required: ['sportType', 'durationMinutes', 'intensity'],
        },
      },
      estimatedKcal: { type: 'number' },
      primarySportType: { type: 'string', enum: [...SPORT_TYPE_ENUM] },
      recurringWeekdays: { type: 'array', items: { type: 'string', enum: [...WEEKDAYS] } },
      timeRangeStart: { type: 'string', description: 'HH:MM' },
      timeRangeEnd: { type: 'string', description: 'HH:MM' },
    },
    required: ['name', 'aliases'],
  },
};

export interface DefineActivityRoutineInput {
  name: string;
  aliases: string[];
  legs?: RoutineLeg[];
  estimatedKcal?: number;
  primarySportType?: SportType;
  recurringWeekdays?: string[];
  timeRangeStart?: string;
  timeRangeEnd?: string;
}

export async function handleDefineActivityRoutineTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as DefineActivityRoutineInput;

  if (!input.legs?.length && (input.estimatedKcal === undefined || !input.primarySportType)) {
    return "Il manque soit le détail des étapes (legs), soit un total kcal connu + le sport principal — demande l'info manquante à l'utilisateur.";
  }

  const existingRoutine = await prisma.activityRoutine.findUnique({ where: { name: input.name } });
  if (existingRoutine) {
    return `Une routine nommée "${input.name}" existe déjà — utilise apply_activity_routine si tu veux l'appliquer, ou choisis un autre nom.`;
  }

  let estimatedKcal: number;
  let blendedDiscountPct: number;

  if (input.legs && input.legs.length > 0) {
    const profile = await getProfileSnapshot();
    if (profile.weightKg === null) {
      return "Le poids actuel de l'utilisateur n'est pas encore connu, nécessaire pour estimer la dépense calorique des étapes. Demande-lui son poids avant de continuer.";
    }

    let totalKcal = 0;
    let weightedDiscount = 0;
    for (const leg of input.legs) {
      const met = lookupMet(leg.sportType, leg.intensity);
      if (met === undefined) {
        return `Aucune table d'estimation calorique n'existe pour le type d'activité "${leg.sportType}" — demande à l'utilisateur les calories connues pour cette routine plutôt que le détail des étapes.`;
      }
      const legKcal = metToKcal(met, leg.durationMinutes, profile.weightKg);
      totalKcal += legKcal;
      weightedDiscount += legKcal * SPORT_DISCOUNTS[leg.sportType];
    }
    estimatedKcal = totalKcal;
    blendedDiscountPct = totalKcal > 0 ? weightedDiscount / totalKcal : 0;
  } else {
    estimatedKcal = input.estimatedKcal as number;
    blendedDiscountPct = SPORT_DISCOUNTS[input.primarySportType as SportType];
  }

  await prisma.activityRoutine.create({
    data: {
      name: input.name,
      aliases: input.aliases,
      legs: input.legs as unknown as Prisma.InputJsonValue | undefined,
      primarySportType: input.primarySportType,
      estimatedKcal,
      blendedDiscountPct,
      sampleCount: 0,
      recurringWeekdays: input.recurringWeekdays ?? [],
      timeRangeStart: input.timeRangeStart,
      timeRangeEnd: input.timeRangeEnd,
    },
  });

  return `Routine "${input.name}" créée : estimation initiale ${estimatedKcal.toFixed(0)} kcal (rabais ${(blendedDiscountPct * 100).toFixed(0)}%).`;
}

// Mirrors `buildScenarioSystemPrompt`: without this the model has no way to know which routines
// exist, and `apply_activity_routine` needs an exact name/alias match.
export async function buildRoutineSystemPromptAddition(): Promise<string> {
  const routines = await prisma.activityRoutine.findMany();
  if (routines.length === 0) return '';
  const list = routines
    .map((r) => {
      const days = r.recurringWeekdays.length ? ` (récurrente : ${r.recurringWeekdays.join(', ')})` : '';
      return `- ${r.name} (alias : ${r.aliases.join(', ') || 'aucun'})${days}`;
    })
    .join('\n');
  return `\n\nRoutines d'activité connues :\n${list}\n\nUtilise apply_activity_routine avec le nom exact ci-dessus quand l'utilisateur mentionne l'une de ces routines.`;
}

export async function findRoutineByNameOrAlias(nameOrAlias: string) {
  const needle = nameOrAlias.trim().toLowerCase();
  const routines = await prisma.activityRoutine.findMany();
  return routines.find(
    (r) => r.name.toLowerCase() === needle || r.aliases.some((a) => a.toLowerCase() === needle)
  );
}

export const APPLY_ACTIVITY_ROUTINE_TOOL: ToolDefinition = {
  name: 'apply_activity_routine',
  description:
    "Applique une routine d'activité déjà définie à une date donnée. " +
    "N'indique PAS reportedKcal si l'utilisateur annonce seulement qu'il va faire cette routine (application proactive, avant que ça ait eu lieu) — l'outil utilise alors la moyenne apprise ou l'estimation de départ. " +
    "Indique reportedKcal si l'utilisateur confirme une occurrence réelle avec un vrai total (ex: sa montre) — ça affine la moyenne de la routine pour la prochaine fois. " +
    "Si l'utilisateur ne rapporte que le réel d'UNE PARTIE de la routine du jour, pas encore terminée (ex: 'l'aller à la gare, 65 kcal' pour une routine 'aller au bureau' qui inclut aussi le retour), " +
    "passe cumulative: true — reportedKcal s'ADDITIONNE alors au total déjà loggé aujourd'hui pour cette routine au lieu de le remplacer. " +
    "N'utilise cumulative: true que si le message ne couvre explicitement qu'une étape/partie ; si l'utilisateur donne le total complet ou corrige un chiffre déjà donné ('en fait c'était 500, pas 450'), n'indique pas cumulative (ou false).",
  input_schema: {
    type: 'object',
    properties: {
      routineName: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      reportedKcal: { type: 'number' },
      cumulative: {
        type: 'boolean',
        description: "true si reportedKcal est une étape supplémentaire à additionner au total du jour déjà loggé pour cette routine.",
      },
    },
    required: ['routineName', 'date'],
  },
};

export interface ApplyActivityRoutineInput {
  routineName: string;
  date: string;
  reportedKcal?: number;
  cumulative?: boolean;
}

export async function handleApplyActivityRoutineTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as ApplyActivityRoutineInput;
  const isReal = input.reportedKcal !== undefined;

  // A confirmed real occurrence already happened, so it can't be dated after today — catches the
  // model miscalculating "today" (e.g. logging tomorrow's date for something the user just did).
  // Checked before the routine lookup: it's a plain input-plausibility check, independent of
  // whether the routine itself exists.
  if (isReal && input.date > todayIsoDate()) {
    return `La date ${input.date} est dans le futur alors qu'un total réel est rapporté (occurrence déjà réalisée) — vérifie la date du jour donnée dans le prompt système et corrige-la avant de réessayer, sauf si l'utilisateur a explicitement précisé une autre date.`;
  }

  const routine = await findRoutineByNameOrAlias(input.routineName);
  if (!routine) {
    return `Aucune routine nommée "${input.routineName}" n'est connue — demande à l'utilisateur de la décrire, puis crée-la avec define_activity_routine avant de réessayer.`;
  }

  // Matched regardless of status: a user correcting an already-confirmed total ("en fait 500,
  // pas 450") must update that same `done` row, not create a second one. `orderBy` ensures that
  // when both a `superseded` estimate and its `done` occurrence exist for the day, the more
  // recently created `done` row is the one found (see the split below).
  const existing = await prisma.activityLog.findFirst({
    where: { date: input.date, routineId: routine.id },
    orderBy: { createdAt: 'desc' },
  });
  const wasAlreadyDone = existing?.status === 'done';
  const previousReportedKcal = existing?.reportedCalories;

  // `cumulative` adds this message's real number to what's already logged today for this
  // routine (e.g. the morning leg, then the evening return, reported as two separate messages)
  // instead of treating it as a correction of the same total.
  const isCumulativeAdd = isReal && input.cumulative === true && wasAlreadyDone && previousReportedKcal !== undefined;
  const effectiveKcal = isReal
    ? isCumulativeAdd
      ? (previousReportedKcal as number) + (input.reportedKcal as number)
      : (input.reportedKcal as number)
    : (routine.observedAvgKcal ?? routine.estimatedKcal);
  const bonusKcal = effectiveKcal * (1 - routine.blendedDiscountPct);

  if (existing && isReal && existing.status === 'planned') {
    // Confirming a real total for this morning's auto-applied estimate: keep the estimate
    // visible (status `superseded`, excluded from the day's bonus sum in
    // `recomputeEventBonusForDate`) instead of overwriting it, so the journal can show both the
    // estimate and the real occurrence side by side.
    await prisma.activityLog.update({
      where: { id: existing.id },
      data: { status: 'superseded' },
    });
    await prisma.activityLog.create({
      data: {
        date: input.date,
        description: routine.name,
        sportType: routine.primarySportType ?? 'other',
        reportedCalories: effectiveKcal,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: effectiveKcal,
        discountPct: routine.blendedDiscountPct,
        bonusKcal,
        estimationMethod: 'device',
        routineId: routine.id,
        status: 'done',
      },
    });
  } else if (existing) {
    // Re-applying after a cancellation revives the occurrence rather than leaving it cancelled.
    const nextStatus = isReal ? 'done' : existing.status === 'cancelled' ? 'planned' : existing.status;
    await prisma.activityLog.update({
      where: { id: existing.id },
      data: { reportedCalories: effectiveKcal, bonusKcal, status: nextStatus },
    });
  } else {
    await prisma.activityLog.create({
      data: {
        date: input.date,
        description: routine.name,
        sportType: routine.primarySportType ?? 'other',
        reportedCalories: effectiveKcal,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: effectiveKcal,
        discountPct: routine.blendedDiscountPct,
        bonusKcal,
        estimationMethod: isReal ? 'device' : 'met_estimate',
        routineId: routine.id,
        status: isReal ? 'done' : 'planned',
      },
    });
  }

  if (isReal) {
    if (wasAlreadyDone && previousReportedKcal !== undefined) {
      // Correction (or cumulative addition) of an occurrence already folded into the average:
      // replace that sample's contribution with the new running total `effectiveKcal` instead of
      // adding a new sample, so the same occurrence isn't absorbed twice.
      const sampleCount = Math.max(routine.sampleCount, 1);
      const sumBefore = (routine.observedAvgKcal ?? routine.estimatedKcal) * sampleCount;
      const newAvg = (sumBefore - previousReportedKcal + effectiveKcal) / sampleCount;
      await prisma.activityRoutine.update({ where: { id: routine.id }, data: { observedAvgKcal: newAvg } });
    } else {
      const newSampleCount = routine.sampleCount + 1;
      const newAvg = ((routine.observedAvgKcal ?? routine.estimatedKcal) * routine.sampleCount + effectiveKcal) / newSampleCount;
      await prisma.activityRoutine.update({
        where: { id: routine.id },
        data: { observedAvgKcal: newAvg, sampleCount: newSampleCount },
      });
    }
  }

  await recomputeEventBonusForDate(input.date);

  if (isCumulativeAdd) {
    return `Étape ajoutée à "${routine.name}" pour le ${input.date} : +${(input.reportedKcal as number).toFixed(0)} kcal, total du jour ${effectiveKcal.toFixed(0)} kcal (${bonusKcal.toFixed(0)} kcal de bonus, rabais ${(routine.blendedDiscountPct * 100).toFixed(0)}%).`;
  }
  const note = isReal ? 'confirmée (réelle)' : 'appliquée par anticipation (estimation)';
  return `Routine "${routine.name}" ${note} pour le ${input.date} : ${bonusKcal.toFixed(0)} kcal de bonus (rabais ${(routine.blendedDiscountPct * 100).toFixed(0)}%).`;
}

export async function getDueRoutinesToday(weekday: string, date: string) {
  const routines = await prisma.activityRoutine.findMany({ where: { recurringWeekdays: { has: weekday } } });
  const due = [];
  for (const routine of routines) {
    const existing = await prisma.activityLog.findFirst({ where: { date, routineId: routine.id } });
    if (!existing) due.push(routine);
  }
  return due;
}

export async function autoApplyRoutineForToday(
  routine: { id: string; name: string; primarySportType: string | null; estimatedKcal: number; blendedDiscountPct: number; observedAvgKcal: number | null; timeRangeStart: string | null },
  date: string
): Promise<{ activityLogId: string; message: string }> {
  const effectiveKcal = routine.observedAvgKcal ?? routine.estimatedKcal;
  const bonusKcal = effectiveKcal * (1 - routine.blendedDiscountPct);

  const log = await prisma.activityLog.create({
    data: {
      date,
      description: routine.name,
      sportType: routine.primarySportType ?? 'other',
      reportedCalories: effectiveKcal,
      relationToPlan: 'additional',
      baselineKcal: 0,
      rawDiffKcal: effectiveKcal,
      discountPct: routine.blendedDiscountPct,
      bonusKcal,
      estimationMethod: 'met_estimate',
      routineId: routine.id,
      status: 'planned',
      plannedTime: routine.timeRangeStart,
    },
  });

  await recomputeEventBonusForDate(date);

  const message = `Aujourd'hui, tu fais normalement "${routine.name}" — cible du jour ajustée de +${bonusKcal.toFixed(0)} kcal (estimation). Dis-moi si ce n'est pas le cas.`;

  return { activityLogId: log.id, message };
}

export async function cancelPlannedActivity(activityLogId: string): Promise<boolean> {
  const log = await prisma.activityLog.findUnique({ where: { id: activityLogId } });
  if (!log) return false;
  // Marked cancelled rather than deleted: `getDueRoutinesToday` treats any existing row for
  // (date, routineId) as "already handled today", so deleting it would make the next
  // 15-minute tick re-apply the routine and undo the user's "Pas aujourd'hui" tap.
  await prisma.activityLog.update({ where: { id: activityLogId }, data: { status: 'cancelled' } });
  await recomputeEventBonusForDate(log.date);
  return true;
}
