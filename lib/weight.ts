import { prisma } from './db.js';
import type { ToolDefinition } from './claude.js';

export interface WeightEntry {
  date: string;
  weightKg: number;
}

export const LOG_WEIGHT_TOOL: ToolDefinition = {
  name: 'log_weight',
  description:
    "Enregistre le poids de l'utilisateur pour une date donnée (aujourd'hui par défaut, sauf indication contraire de l'utilisateur). Un nouveau relevé pour la même date remplace le précédent.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      weightKg: { type: 'number' },
    },
    required: ['date', 'weightKg'],
  },
};

export async function saveWeight(entry: WeightEntry): Promise<void> {
  await prisma.weight.upsert({
    where: { date: entry.date },
    create: { date: entry.date, weightKg: entry.weightKg, source: 'manual' },
    update: { weightKg: entry.weightKg, source: 'manual' },
  });
}

export async function handleLogWeightTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as WeightEntry;
  await saveWeight(input);
  return `Poids du ${input.date} enregistré : ${input.weightKg} kg.`;
}
