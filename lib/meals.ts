import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { searchFoodCandidates } from './foods.js';
import { normalizeFoodName } from './ciqualParser.js';
import type { ToolDefinition } from './claude.js';

export interface MealItem {
  name: string;
  estimatedGrams: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface LogMealInput {
  rawDescription: string;
  items: MealItem[];
  kcalLow: number;
  kcalMid: number;
  kcalHigh: number;
}

export const LOG_MEAL_TOOL: ToolDefinition = {
  name: 'log_meal',
  description:
    "Enregistre un repas décrit en langage naturel, SANS grammage précis (ex: \"une assiette de pâtes bolognaise\"). Estime les aliments, leurs macronutriments, et donne TOUJOURS une fourchette calorique (kcalLow/kcalMid/kcalHigh) — jamais un chiffre unique, l'estimation par description reste approximative. Si l'utilisateur donne un grammage précis pour chaque aliment, utilise log_weighed_meal à la place.",
  input_schema: {
    type: 'object',
    properties: {
      rawDescription: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            estimatedGrams: { type: 'number' },
            kcal: { type: 'number' },
            proteinG: { type: 'number' },
            carbsG: { type: 'number' },
            fatG: { type: 'number' },
          },
          required: ['name', 'estimatedGrams', 'kcal', 'proteinG', 'carbsG', 'fatG'],
        },
      },
      kcalLow: { type: 'number' },
      kcalMid: { type: 'number' },
      kcalHigh: { type: 'number' },
    },
    required: ['rawDescription', 'items', 'kcalLow', 'kcalMid', 'kcalHigh'],
  },
};

export async function handleLogMealTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogMealInput;

  await prisma.meal.create({
    data: {
      inputType: 'text',
      rawDescription: input.rawDescription,
      items: input.items as unknown as Prisma.InputJsonValue,
      kcalLow: input.kcalLow,
      kcalMid: input.kcalMid,
      kcalHigh: input.kcalHigh,
      confidence: 'medium',
      userCorrected: false,
    },
  });

  return `Repas enregistré : ${input.kcalLow}-${input.kcalHigh} kcal (estimation ~${input.kcalMid} kcal), confiance moyenne.`;
}

export interface WeighedMealItemInput {
  foodQuery: string;
  grams: number;
}

export interface LogWeighedMealInput {
  rawDescription: string;
  items: WeighedMealItemInput[];
}

export const LOG_WEIGHED_MEAL_TOOL: ToolDefinition = {
  name: 'log_weighed_meal',
  description:
    "Enregistre un repas pesé, quand l'utilisateur donne un grammage précis pour chaque aliment (ex: \"200g de riz basmati cuit, 150g de poulet\"). Ne calcule JAMAIS toi-même les calories ou macros : donne uniquement le nom de chaque aliment tel que décrit et son poids en grammes, l'outil fait la recherche dans la base Ciqual et le calcul exact. Si l'outil répond que plusieurs aliments correspondent, pose la question à l'utilisateur pour choisir, puis rappelle l'outil avec un nom plus précis.",
  input_schema: {
    type: 'object',
    properties: {
      rawDescription: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            foodQuery: { type: 'string', description: "Nom de l'aliment tel que décrit par l'utilisateur" },
            grams: { type: 'number' },
          },
          required: ['foodQuery', 'grams'],
        },
      },
    },
    required: ['rawDescription', 'items'],
  },
};

export async function handleLogWeighedMealTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogWeighedMealInput;

  const resolvedItems: MealItem[] = [];
  const notFound: string[] = [];
  const ambiguous: { query: string; candidateNames: string[] }[] = [];

  for (const item of input.items) {
    const candidates = await searchFoodCandidates(item.foodQuery);

    if (candidates.length === 0) {
      notFound.push(item.foodQuery);
      continue;
    }

    const exactMatch = candidates.find(
      (c) => normalizeFoodName(c.name) === normalizeFoodName(item.foodQuery)
    );
    const food = exactMatch ?? (candidates.length === 1 ? candidates[0] : undefined);

    if (!food) {
      ambiguous.push({ query: item.foodQuery, candidateNames: candidates.map((c) => c.name) });
      continue;
    }

    const ratio = item.grams / 100;
    resolvedItems.push({
      name: food.name,
      estimatedGrams: item.grams,
      kcal: food.kcalPer100g * ratio,
      proteinG: food.proteinPer100g * ratio,
      carbsG: food.carbsPer100g * ratio,
      fatG: food.fatPer100g * ratio,
    });
  }

  if (notFound.length > 0 || ambiguous.length > 0) {
    const parts: string[] = [];
    if (ambiguous.length > 0) {
      const list = ambiguous
        .map((a) => `"${a.query}" → ${a.candidateNames.map((n, i) => `${i + 1}) ${n}`).join(' ')}`)
        .join(' | ');
      parts.push(`Plusieurs aliments Ciqual correspondent, demande à l'utilisateur de préciser lequel : ${list}.`);
    }
    if (notFound.length > 0) {
      parts.push(
        `Aliment(s) non trouvé(s) dans la base Ciqual : ${notFound.join(', ')}. Décris-les autrement (plus simple ou plus générique) ou utilise le mode "repas décrit".`
      );
    }
    return parts.join(' ');
  }

  const totalKcal = resolvedItems.reduce((sum, i) => sum + i.kcal, 0);

  await prisma.meal.create({
    data: {
      inputType: 'text',
      rawDescription: input.rawDescription,
      items: resolvedItems as unknown as Prisma.InputJsonValue,
      kcalLow: totalKcal,
      kcalMid: totalKcal,
      kcalHigh: totalKcal,
      confidence: 'high',
      userCorrected: false,
    },
  });

  return `Repas pesé enregistré : ${totalKcal.toFixed(0)} kcal (${resolvedItems.length} aliment(s), confiance haute — lookup Ciqual).`;
}
