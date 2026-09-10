import { prisma } from './db.js';
import { kcalFloor, bootstrapTargetKcal } from './calc/baseline.js';
import { predictedTdee, BASE_ACTIVITY_FACTOR } from './calc/tdee.js';
import { getProfileSnapshot, applyBodyScanToProfile } from './profile.js';
import { weekdayOf } from './dateUtils.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import type { ToolDefinition } from './claude.js';

export interface SetBodyScanInput {
  date: string;
  weightKg: number;
  leanMassKg: number;
  fatMassKg?: number;
  fatPct?: number;
  boneMassKg?: number;
  waterPct?: number;
  visceralFat?: number;
  reportedBmr?: number;
}

export const BODY_SCAN_PDF_PROMPT = `

Quand un PDF de composition corporelle est joint au message, extrais-en la date de la mesure, le poids, la masse maigre, et si présents : masse grasse, % de graisse, masse osseuse, % d'eau, graisse viscérale, métabolisme de base rapporté.
Rappelle que l'impédancemétrie varie selon l'hydratation et l'heure — à traiter en tendance, jamais en absolu.
Résume les valeurs extraites clairement et demande une confirmation explicite avant d'enregistrer.
N'appelle set_body_scan qu'après une confirmation explicite de l'utilisateur dans un message ultérieur (« oui », « confirme », « c'est bon ») — jamais dans le même tour que l'extraction initiale.`;

export const SET_BODY_SCAN_TOOL: ToolDefinition = {
  name: 'set_body_scan',
  description:
    "Enregistre un scan de composition corporelle saisi manuellement par l'utilisateur (poids, masse maigre, et éventuellement masse grasse/% graisse/masse osseuse/% eau/graisse viscérale/BMR rapporté par la machine). La masse maigre est le champ le plus important : elle détermine le plancher calorique et amorce la cible calorique tant qu'aucune boucle d'ajustement n'est encore active. Utilise cet outil tant que le vrai PDF du scan n'est pas disponible ; un futur parsing PDF alimentera les mêmes champs.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      weightKg: { type: 'number' },
      leanMassKg: { type: 'number' },
      fatMassKg: { type: 'number' },
      fatPct: { type: 'number' },
      boneMassKg: { type: 'number' },
      waterPct: { type: 'number' },
      visceralFat: { type: 'number' },
      reportedBmr: { type: 'number' },
    },
    required: ['date', 'weightKg', 'leanMassKg'],
  },
};

export async function handleSetBodyScanTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as SetBodyScanInput;

  await prisma.bodyScan.upsert({
    where: { date: input.date },
    create: {
      date: input.date,
      weightKg: input.weightKg,
      leanMassKg: input.leanMassKg,
      fatMassKg: input.fatMassKg,
      fatPct: input.fatPct,
      boneMassKg: input.boneMassKg,
      waterPct: input.waterPct,
      visceralFat: input.visceralFat,
      reportedBmr: input.reportedBmr,
      source: 'manual',
    },
    update: {
      weightKg: input.weightKg,
      leanMassKg: input.leanMassKg,
      fatMassKg: input.fatMassKg,
      fatPct: input.fatPct,
      boneMassKg: input.boneMassKg,
      waterPct: input.waterPct,
      visceralFat: input.visceralFat,
      reportedBmr: input.reportedBmr,
      source: 'manual',
    },
  });

  const newKcalFloor = kcalFloor(input.leanMassKg);
  const profile = await getProfileSnapshot();

  let bootstrappedTargetKcal: number | undefined;
  if (profile.currentTargetKcal === null && profile.ratePctPerWeek !== null && profile.weightKg !== null) {
    const weeklyDefault = await getWeeklyDefault(weekdayOf(input.date));
    const predicted = predictedTdee({
      leanMassKg: input.leanMassKg,
      activityFactor: BASE_ACTIVITY_FACTOR,
      plannedSegmentsKcal: weeklyDefault?.avgKcal ?? 0,
    });
    bootstrappedTargetKcal = bootstrapTargetKcal(predicted, profile.ratePctPerWeek, profile.weightKg, newKcalFloor);
  }

  await applyBodyScanToProfile({
    leanMassKg: input.leanMassKg,
    kcalFloor: newKcalFloor,
    currentTargetKcal: bootstrappedTargetKcal,
  });

  const bootstrapNote = bootstrappedTargetKcal
    ? ` Cible calorique initiale fixée à ${bootstrappedTargetKcal.toFixed(0)} kcal/jour (sera affinée par la boucle d'observation dès 14 jours de données).`
    : '';

  return `Scan enregistré : masse maigre ${input.leanMassKg} kg → plancher calorique ${newKcalFloor.toFixed(0)} kcal/jour.${bootstrapNote}`;
}
