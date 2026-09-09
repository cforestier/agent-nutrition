import { prisma } from './db.js';
import { normalizeFoodName } from './ciqualParser.js';

export interface FoodMatch {
  name: string;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

export async function searchFood(query: string): Promise<FoodMatch | null> {
  const normalized = normalizeFoodName(query);

  const matches = await prisma.food.findMany({
    where: { nameNormalized: { contains: normalized } },
  });

  if (matches.length === 0) return null;

  matches.sort((a, b) => a.name.length - b.name.length);
  return matches[0];
}
