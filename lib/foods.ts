import { prisma } from './db.js';
import { normalizeFoodName } from './ciqualParser.js';

export interface FoodMatch {
  name: string;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

export async function searchFoodCandidates(query: string, limit = 5): Promise<FoodMatch[]> {
  const normalized = normalizeFoodName(query);

  const matches = await prisma.food.findMany({
    where: { nameNormalized: { contains: normalized } },
  });

  matches.sort((a, b) => a.name.length - b.name.length);
  return matches.slice(0, limit);
}
