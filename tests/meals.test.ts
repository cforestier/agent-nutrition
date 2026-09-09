import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogMealTool } from '../lib/meals.js';

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
