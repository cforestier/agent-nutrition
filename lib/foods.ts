import { prisma } from './db.js';
import { tokenizeFoodName, isCookedToken, isRawToken } from './ciqualParser.js';

export interface FoodMatch {
  name: string;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

export async function searchFoodCandidates(query: string, limit = 5): Promise<FoodMatch[]> {
  const queryTokens = tokenizeFoodName(query);
  if (queryTokens.length === 0) return [];

  // Cooking-state words ("cuit", "cru") describe how the food was prepared, not what it is —
  // matching on them as regular tokens would require the DB name to contain that exact word,
  // which Ciqual rarely does (it says "rôtie", "grillé/poêlé", etc). So they're excluded from
  // the required core tokens and instead used to include/exclude candidates by cooked vs raw.
  const coreTokens = queryTokens.filter((t) => !isCookedToken(t) && !isRawToken(t));
  const anchorTokens = coreTokens.length > 0 ? coreTokens : queryTokens;
  const wantsCooked = queryTokens.some(isCookedToken);
  const wantsRaw = queryTokens.some(isRawToken);

  // Narrow the DB scan with the most distinctive (longest) core token; correctness is still
  // enforced below by requiring every core token, not just the anchor, to be present.
  const anchor = [...anchorTokens].sort((a, b) => b.length - a.length)[0];
  const pool = await prisma.food.findMany({
    where: { nameNormalized: { contains: anchor } },
  });

  const matches = pool.filter((food) => {
    const foodTokens = new Set(tokenizeFoodName(food.name));
    if (!anchorTokens.every((t) => foodTokens.has(t))) return false;
    // Require an affirmative match, not just the absence of a contradiction — otherwise foods
    // that simply don't mention any cooking state ("Graisse de poulet", "Couscous au poulet")
    // would slip through a "cuit" query just because they aren't tagged "cru" either.
    if (wantsCooked && ![...foodTokens].some(isCookedToken)) return false;
    if (wantsRaw && ![...foodTokens].some(isRawToken)) return false;
    return true;
  });

  // Prefer candidates where a core token is the primary subject ("Poulet, filet...") over ones
  // where it's just a modifier of something else ("Foie, poulet, cuit" = liver, not chicken).
  const startsWithCore = (name: string) => {
    const firstToken = tokenizeFoodName(name)[0];
    return anchorTokens.includes(firstToken);
  };
  matches.sort((a, b) => {
    const primaryDiff = Number(!startsWithCore(a.name)) - Number(!startsWithCore(b.name));
    return primaryDiff !== 0 ? primaryDiff : a.name.length - b.name.length;
  });
  return matches.slice(0, limit);
}
