import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { getDailyJournal } from '../lib/journal.js';

describe('getDailyJournal', () => {
  const testDate = '1990-01-05';
  const emptyDate = '1990-01-06';
  const mealIds: string[] = [];
  const activityIds: string[] = [];

  afterAll(async () => {
    await Promise.all(mealIds.map((id) => prisma.meal.delete({ where: { id } })));
    await Promise.all(activityIds.map((id) => prisma.activityLog.delete({ where: { id } })));
    await prisma.weight.deleteMany({ where: { date: { in: [testDate, emptyDate] } } });
    await prisma.sleepLog.deleteMany({ where: { date: { in: [testDate, emptyDate] } } });
  });

  it('gathers meals, activities, weight and sleep logged for a given date', async () => {
    const meal = await prisma.meal.create({
      data: {
        datetime: new Date(`${testDate}T12:30:00Z`),
        inputType: 'text',
        rawDescription: 'assiette de pâtes',
        items: [{ name: 'pâtes', estimatedGrams: 200, kcal: 700, proteinG: 20, carbsG: 120, fatG: 10 }],
        kcalLow: 650,
        kcalMid: 700,
        kcalHigh: 750,
        confidence: 'medium',
      },
    });
    mealIds.push(meal.id);

    const activity = await prisma.activityLog.create({
      data: {
        date: testDate,
        description: 'vélo chez un ami',
        sportType: 'cycling',
        reportedCalories: 381,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: 381,
        discountPct: 0.2,
        bonusKcal: 305,
        intensity: 'moderate',
        durationMinutes: 40,
        estimationMethod: 'met_estimate',
        metUsed: 6.8,
      },
    });
    activityIds.push(activity.id);

    await prisma.weight.upsert({
      where: { date: testDate },
      create: { date: testDate, weightKg: 79.5, source: 'manual' },
      update: { weightKg: 79.5, source: 'manual' },
    });

    await prisma.sleepLog.upsert({
      where: { date: testDate },
      create: { date: testDate, quality: 'good' },
      update: { quality: 'good' },
    });

    const journal = await getDailyJournal(testDate);

    expect(journal.date).toBe(testDate);
    expect(journal.meals).toHaveLength(1);
    expect(journal.meals[0].rawDescription).toBe('assiette de pâtes');
    expect(journal.meals[0].kcalMid).toBe(700);
    expect(journal.meals[0].time).toBe('12:30');

    expect(journal.activities).toHaveLength(1);
    expect(journal.activities[0].description).toBe('vélo chez un ami');
    expect(journal.activities[0].intensity).toBe('moderate');
    expect(journal.activities[0].durationMinutes).toBe(40);
    expect(journal.activities[0].estimationMethod).toBe('met_estimate');
    expect(journal.activities[0].reportedCalories).toBe(381);

    expect(journal.weightKg).toBe(79.5);
    expect(journal.sleepQuality).toBe('good');
  });

  it('returns empty lists and null extras for a day with nothing logged', async () => {
    const journal = await getDailyJournal(emptyDate);

    expect(journal.meals).toEqual([]);
    expect(journal.activities).toEqual([]);
    expect(journal.weightKg).toBeNull();
    expect(journal.sleepQuality).toBeNull();
  });
});
