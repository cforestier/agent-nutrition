import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogMealTool, handleLogWeighedMealTool } from '../lib/meals.js';
import * as foodsLib from '../lib/foods.js';

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
