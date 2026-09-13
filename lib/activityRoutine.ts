import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { getProfileSnapshot } from './profile.js';
import { lookupMet, metToKcal, SPORT_DISCOUNTS } from './activity.js';
import type { SportType, Intensity } from './activity.js';
import { WEEKDAYS } from './weeklySchedule.js';
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

  if (!input.legs && (input.estimatedKcal === undefined || !input.primarySportType)) {
    return "Il manque soit le détail des étapes (legs), soit un total kcal connu + le sport principal — demande l'info manquante à l'utilisateur.";
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

export async function findRoutineByNameOrAlias(nameOrAlias: string) {
  const needle = nameOrAlias.trim().toLowerCase();
  const routines = await prisma.activityRoutine.findMany();
  return routines.find(
    (r) => r.name.toLowerCase() === needle || r.aliases.some((a) => a.toLowerCase() === needle)
  );
}
