import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { getTodaySummary } from '../lib/todaySummary.js';
import * as profileLib from '../lib/profile.js';

describe('getTodaySummary', () => {
  const testDate = '1999-10-05';
  const emptyDate = '1999-10-06';
  const mealIds: string[] = [];

  afterAll(async () => {
    await Promise.all(mealIds.map((id) => prisma.meal.delete({ where: { id } })));
    await prisma.dayPlan.deleteMany({ where: { date: { in: [testDate, emptyDate] } } });
  });

  it('sums meals for the date and computes target/protein-range from the profile', async () => {
    const meal = await prisma.meal.create({
      data: {
        datetime: new Date(`${testDate}T12:00:00Z`),
        inputType: 'text',
        rawDescription: 'test meal',
        items: [{ name: 'test-item', estimatedGrams: 100, kcal: 600, proteinG: 40, carbsG: 60, fatG: 20 }],
        kcalLow: 600,
        kcalMid: 600,
        kcalHigh: 600,
        confidence: 'high',
      },
    });
    mealIds.push(meal.id);

    await prisma.dayPlan.upsert({
      where: { date: testDate },
      create: { date: testDate, scenariosApplied: [], segmentsResolved: [], isAtypical: true, eventBonusKcal: 150 },
      update: { isAtypical: true, eventBonusKcal: 150 },
    });

    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 76,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 58.63,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: null,
      consecutiveDeficitWeeks: 0,
      weighInDay: null,
      reviewDay: null,
    });

    const result = await getTodaySummary(testDate);

    expect(result.totalKcal).toBe(600);
    expect(result.proteinG).toBe(40);
    expect(result.carbsG).toBe(60);
    expect(result.fatG).toBe(20);
    expect(result.targetKcal).toBeCloseTo(2650, 5); // 2500 + 150 bonus
    expect(result.proteinTargetMinG).toBeCloseTo(152, 1); // 76 * 2.0
    expect(result.proteinTargetMaxG).toBeCloseTo(167.2, 1); // 76 * 2.2
    expect(result.fatTargetG).toBeCloseTo(73.61, 1); // 2650 * 0.25 / 9
    expect(result.carbsTargetG).toBeCloseTo(344.88, 1); // (2650 - 152*4 - 73.61*9) / 4
  });

  it('returns zeros and null targets when there is no data for the date or the profile', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: null,
      ratePctPerWeek: null,
      currentTargetKcal: null,
      leanMassKg: null,
      kcalFloor: null,
      baselineStartedAt: null,
      lastAdjustmentDate: null,
      consecutiveDeficitWeeks: 0,
      weighInDay: null,
      reviewDay: null,
    });

    const result = await getTodaySummary(emptyDate);

    expect(result.totalKcal).toBe(0);
    expect(result.proteinG).toBe(0);
    expect(result.targetKcal).toBeNull();
    expect(result.proteinTargetMinG).toBeNull();
    expect(result.proteinTargetMaxG).toBeNull();
    expect(result.fatTargetG).toBeNull();
    expect(result.carbsTargetG).toBeNull();
  });
});
