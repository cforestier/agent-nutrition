import { prisma } from './db.js';
import { weekdayOf } from './dateUtils.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import { getProfileSnapshot } from './profile.js';
import type { ToolDefinition } from './claude.js';

export type SportType = 'cycling' | 'running' | 'strength' | 'other';

const SPORT_DISCOUNTS: Record<SportType, number> = {
  cycling: 0.2,
  running: 0.25,
  strength: 0.3,
  other: 0.35,
};

const MATERIALITY_THRESHOLD_KCAL = 100;

export interface LogActivityInput {
  date: string;
  description: string;
  sportType: SportType;
  reportedCalories: number;
  relationToPlan: 'replaces' | 'additional';
}

export const LOG_ACTIVITY_TOOL: ToolDefinition = {
  name: 'log_activity',
  description:
    "Enregistre une activité physique rapportée par l'utilisateur avec les calories affichées par sa montre/tracker. " +
    "Si l'utilisateur ne précise pas si cette activité REMPLACE l'activité initialement prévue pour la journée ou si elle est EN PLUS, " +
    "demande-le lui explicitement avant d'appeler cet outil — ne suppose jamais.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      description: { type: 'string' },
      sportType: { type: 'string', enum: ['cycling', 'running', 'strength', 'other'] },
      reportedCalories: { type: 'number' },
      relationToPlan: { type: 'string', enum: ['replaces', 'additional'] },
    },
    required: ['date', 'description', 'sportType', 'reportedCalories', 'relationToPlan'],
  },
};

export async function handleLogActivityTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogActivityInput;

  const weeklyDefault = await getWeeklyDefault(weekdayOf(input.date));
  const baselineKcal = weeklyDefault?.avgKcal ?? 0;

  const rawDiffKcal = input.relationToPlan === 'replaces' ? input.reportedCalories - baselineKcal : input.reportedCalories;

  const discountPct = SPORT_DISCOUNTS[input.sportType];
  const adjustedDiffKcal = rawDiffKcal * (1 - discountPct);
  const bonusKcal = Math.abs(adjustedDiffKcal) >= MATERIALITY_THRESHOLD_KCAL ? adjustedDiffKcal : 0;

  await prisma.activityLog.create({
    data: {
      date: input.date,
      description: input.description,
      sportType: input.sportType,
      reportedCalories: input.reportedCalories,
      relationToPlan: input.relationToPlan,
      baselineKcal,
      rawDiffKcal,
      discountPct,
      bonusKcal,
    },
  });

  if (bonusKcal === 0) {
    return `Activité enregistrée (${input.description}, ${input.reportedCalories} kcal). Écart avec le prévu trop faible (moins de ${MATERIALITY_THRESHOLD_KCAL} kcal après rabais) pour ajuster ta cible — considérée comme normale.`;
  }

  await prisma.dayPlan.upsert({
    where: { date: input.date },
    create: {
      date: input.date,
      scenariosApplied: [],
      segmentsResolved: [],
      isAtypical: true,
      eventBonusKcal: bonusKcal,
    },
    update: { isAtypical: true, eventBonusKcal: bonusKcal },
  });

  const profile = await getProfileSnapshot();
  const sign = bonusKcal > 0 ? '+' : '';
  const newTargetNote =
    profile.currentTargetKcal !== null ? ` → ${(profile.currentTargetKcal + bonusKcal).toFixed(0)} kcal aujourd'hui` : '';

  return `Activité enregistrée (${input.description}, ${input.reportedCalories} kcal, rabais ${(discountPct * 100).toFixed(0)}%). Cible du jour ajustée de ${sign}${bonusKcal.toFixed(0)} kcal${newTargetNote}.`;
}
