import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogMealTool, handleLogWeighedMealTool } from '../lib/meals.js';
import type { MealItem } from '../lib/meals.js';
import * as foodsLib from '../lib/foods.js';

async function deleteMealsWithRawDescription(rawDescription: string): Promise<void> {
  const rows = await prisma.meal.findMany({ where: { rawDescription } });
  for (const row of rows) await prisma.meal.delete({ where: { id: row.id } });
}

describe('handleLogMealTool', () => {
  const marker = `test-${Date.now()}-pates-bolognaise`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.meal.delete({ where: { id: createdId } });
  });

  it('saves a described meal with a calorie range and returns a confirmation', async () => {
    const result = await handleLogMealTool({
      rawDescription: marker,
      items: [
        { name: 'pâtes', estimatedGrams: 250, kcal: 350, proteinG: 12, carbsG: 70, fatG: 2 },
        { name: 'sauce bolognaise', estimatedGrams: 150, kcal: 220, proteinG: 15, carbsG: 8, fatG: 14 },
      ],
      kcalLow: 500,
      kcalMid: 570,
      kcalHigh: 650,
    });

    expect(result).toContain('500');
    expect(result).toContain('650');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: marker } });
    createdId = saved?.id;
    expect(saved?.inputType).toBe('text');
    expect(saved?.confidence).toBe('medium');
    expect(saved?.userCorrected).toBe(false);
    expect(saved?.kcalLow).toBe(500);
    expect(saved?.kcalHigh).toBe(650);
    expect(saved?.items).toEqual([
      { name: 'pâtes', estimatedGrams: 250, kcal: 350, proteinG: 12, carbsG: 70, fatG: 2 },
      { name: 'sauce bolognaise', estimatedGrams: 150, kcal: 220, proteinG: 15, carbsG: 8, fatG: 14 },
    ]);
  });
});

describe('handleLogWeighedMealTool', () => {
  const marker = `test-${Date.now()}-riz-poulet-pese`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.meal.delete({ where: { id: createdId } });
  });

  it('looks up each food, computes exact macros from grams, and saves with high confidence', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockImplementation(async (query: string) => {
      if (query.includes('riz')) {
        return [{ name: 'Riz basmati, cuit', kcalPer100g: 140, proteinPer100g: 3, carbsPer100g: 30, fatPer100g: 0.5 }];
      }
      if (query.includes('poulet')) {
        return [{ name: 'Poulet, blanc, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 }];
      }
      return [];
    });

    const result = await handleLogWeighedMealTool({
      rawDescription: marker,
      items: [
        { foodQuery: 'riz basmati cuit', grams: 200 },
        { foodQuery: 'poulet', grams: 150 },
      ],
    });

    expect(result).toContain('528');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: marker } });
    createdId = saved?.id;
    expect(saved?.inputType).toBe('text');
    expect(saved?.confidence).toBe('high');
    expect(saved?.kcalLow).toBe(saved?.kcalHigh);
    expect(saved?.items).toEqual([
      { name: 'Riz basmati, cuit', estimatedGrams: 200, kcal: 280, proteinG: 6, carbsG: 60, fatG: 1 },
      { name: 'Poulet, blanc, cuit', estimatedGrams: 150, kcal: 247.5, proteinG: 46.5, carbsG: 0, fatG: 5.4 },
    ]);
  });

  it('returns a clarification message and saves nothing when a food is not found', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([]);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-notfound`,
      items: [{ foodQuery: 'aliment-inexistant-xyz', grams: 100 }],
    });

    expect(result).toContain('non trouvé');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-notfound` } });
    expect(saved).toBeNull();
  });

  it('asks for clarification and saves nothing when a query matches multiple foods ambiguously', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: 'Poulet, cru', kcalPer100g: 120, proteinPer100g: 21, carbsPer100g: 0, fatPer100g: 3 },
      { name: 'Poulet, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 },
      { name: 'Poulet rôti', kcalPer100g: 190, proteinPer100g: 27, carbsPer100g: 0, fatPer100g: 9 },
    ]);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-ambiguous`,
      items: [{ foodQuery: 'poulet', grams: 150 }],
    });

    expect(result).toContain('Poulet, cru');
    expect(result).toContain('Poulet, cuit');
    expect(result).toContain('Poulet rôti');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-ambiguous` } });
    expect(saved).toBeNull();
  });

  it('saves the resolved foods immediately and only reports the ambiguous one, instead of blocking the whole meal', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockImplementation(async (query: string) => {
      if (query.includes('pastèque')) {
        return [{ name: 'Pastèque, crue', kcalPer100g: 30, proteinPer100g: 0.6, carbsPer100g: 7, fatPer100g: 0.2 }];
      }
      return [
        { name: 'Pâtes, cuites', kcalPer100g: 158, proteinPer100g: 5, carbsPer100g: 31, fatPer100g: 1 },
        { name: 'Pâtes fraîches, cuites', kcalPer100g: 175, proteinPer100g: 6, carbsPer100g: 34, fatPer100g: 1.5 },
      ];
    });

    const partialMarker = `${marker}-partial`;
    const result = await handleLogWeighedMealTool({
      rawDescription: partialMarker,
      items: [
        { foodQuery: 'pastèque', grams: 200 },
        { foodQuery: 'pâtes', grams: 250 },
      ],
    });

    expect(result).toContain('Repas pesé enregistré');
    expect(result).toContain('Pâtes, cuites');
    expect(result).toContain('Pâtes fraîches, cuites');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: partialMarker } });
    expect(saved).not.toBeNull();
    expect(saved?.items).toEqual([
      { name: 'Pastèque, crue', estimatedGrams: 200, kcal: 60, proteinG: 1.2, carbsG: 14, fatG: 0.4 },
    ]);

    // Simulates the model re-calling the tool with the FULL original item list (pastèque + the
    // now-clarified pâtes) instead of only the clarified one — pastèque must not be logged twice.
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockImplementation(async (query: string) => {
      if (query.includes('pastèque')) {
        return [{ name: 'Pastèque, crue', kcalPer100g: 30, proteinPer100g: 0.6, carbsPer100g: 7, fatPer100g: 0.2 }];
      }
      return [{ name: 'Pâtes, cuites', kcalPer100g: 158, proteinPer100g: 5, carbsPer100g: 31, fatPer100g: 1 }];
    });

    const secondResult = await handleLogWeighedMealTool({
      rawDescription: partialMarker,
      items: [
        { foodQuery: 'pastèque', grams: 200 },
        { foodQuery: 'Pâtes, cuites', grams: 250 },
      ],
    });

    expect(secondResult).toContain('déjà enregistré');

    const mealsForMarker = await prisma.meal.findMany({ where: { rawDescription: partialMarker } });
    expect(mealsForMarker).toHaveLength(2);
    const watermelonRows = mealsForMarker.flatMap((m) => m.items as unknown as MealItem[]).filter((i) => i.name === 'Pastèque, crue');
    expect(watermelonRows).toHaveLength(1);
    const pastaRows = mealsForMarker.flatMap((m) => m.items as unknown as MealItem[]).filter((i) => i.name === 'Pâtes, cuites');
    expect(pastaRows).toHaveLength(1);

    for (const m of mealsForMarker) await prisma.meal.delete({ where: { id: m.id } });
  });

  it('auto-resolves when one candidate is an exact normalized-name match, even among several candidates', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: 'Poulet, cru', kcalPer100g: 120, proteinPer100g: 21, carbsPer100g: 0, fatPer100g: 3 },
      { name: 'Poulet, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 },
    ]);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-exact`,
      items: [{ foodQuery: 'Poulet, cuit', grams: 100 }],
    });

    expect(result).toContain('165');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-exact` } });
    expect(saved?.confidence).toBe('high');
    if (saved) await prisma.meal.delete({ where: { id: saved.id } });
  });
});

describe('cross-meal duplicate confirmation window', () => {
  const foodName = `Test Duplicate Food ${Date.now()}`;
  const firstMarker = `test-${Date.now()}-dup-first`;
  const secondMarker = `test-${Date.now()}-dup-second`;
  const confirmedMarker = `test-${Date.now()}-dup-confirmed`;

  afterAll(async () => {
    await deleteMealsWithRawDescription(firstMarker);
    await deleteMealsWithRawDescription(secondMarker);
    await deleteMealsWithRawDescription(confirmedMarker);
  });

  it('asks for confirmation instead of auto-logging when the same food reappears within 30 minutes of a closed meal', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: foodName, kcalPer100g: 200, proteinPer100g: 10, carbsPer100g: 20, fatPer100g: 5 },
    ]);

    const firstResult = await handleLogWeighedMealTool({
      rawDescription: firstMarker,
      items: [{ foodQuery: foodName, grams: 100 }],
    });
    expect(firstResult).toContain('Repas pesé enregistré');

    const secondResult = await handleLogWeighedMealTool({
      rawDescription: secondMarker,
      items: [{ foodQuery: foodName, grams: 100 }],
    });

    expect(secondResult).toContain('portion supplémentaire');
    const savedSecond = await prisma.meal.findFirst({ where: { rawDescription: secondMarker } });
    expect(savedSecond).toBeNull();
  });

  it('saves the food once the model resubmits it with confirmDuplicate: true', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: foodName, kcalPer100g: 200, proteinPer100g: 10, carbsPer100g: 20, fatPer100g: 5 },
    ]);

    const result = await handleLogWeighedMealTool({
      rawDescription: confirmedMarker,
      items: [{ foodQuery: foodName, grams: 100, confirmDuplicate: true }],
    });

    expect(result).toContain('Repas pesé enregistré');
    const saved = await prisma.meal.findFirst({ where: { rawDescription: confirmedMarker } });
    expect(saved).not.toBeNull();
  });

  it('does not ask for confirmation when the previous log of the same food is older than the duplicate window', async () => {
    const oldFoodName = `Test Old Duplicate Food ${Date.now()}`;
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: oldFoodName, kcalPer100g: 150, proteinPer100g: 8, carbsPer100g: 15, fatPer100g: 4 },
    ]);

    const oldMarker = `test-${Date.now()}-old-dup`;
    const newMarker = `test-${Date.now()}-old-dup-new`;

    const old = await prisma.meal.create({
      data: {
        inputType: 'text',
        rawDescription: oldMarker,
        items: [{ name: oldFoodName, estimatedGrams: 100, kcal: 150, proteinG: 8, carbsG: 15, fatG: 4 }],
        kcalLow: 150,
        kcalMid: 150,
        kcalHigh: 150,
        confidence: 'high',
        userCorrected: false,
        createdAt: new Date(Date.now() - 40 * 60 * 1000),
      },
    });

    const result = await handleLogWeighedMealTool({
      rawDescription: newMarker,
      items: [{ foodQuery: oldFoodName, grams: 100 }],
    });

    expect(result).toContain('Repas pesé enregistré');
    const saved = await prisma.meal.findFirst({ where: { rawDescription: newMarker } });
    expect(saved).not.toBeNull();

    await prisma.meal.delete({ where: { id: old.id } });
    if (saved) await prisma.meal.delete({ where: { id: saved.id } });
  });
});
