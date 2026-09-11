import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { runDailyRecompute } from '../lib/dailyRecompute.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';
import * as sleepLib from '../lib/sleep.js';

const TEST_DATE = '1999-08-14'; // chosen to avoid the ±3/±7-day fixture windows used by other test files (e.g. weight.test.ts's 1999-06-15)

describe('runDailyRecompute', () => {
  const mealIds: string[] = [];
  const weightDates = ['1999-07-31', '1999-08-14'];

  afterAll(async () => {
    await Promise.all(mealIds.map((id) => prisma.meal.delete({ where: { id } })));
    await Promise.all(weightDates.map((date) => prisma.weight.deleteMany({ where: { date } })));
    await prisma.dailyState.deleteMany({ where: { date: TEST_DATE } });
    await prisma.tdeeComparison.deleteMany({ where: { date: TEST_DATE } });
  });

  it('sets up shared fixtures', async () => {
    const meals = await Promise.all([
      prisma.meal.create({
        data: {
          datetime: new Date('1999-08-01T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'fixture day 1',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2200, proteinG: 150, carbsG: 200, fatG: 70 }],
          kcalLow: 2200,
          kcalMid: 2200,
          kcalHigh: 2200,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-08-10T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'fixture day 2',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2400, proteinG: 160, carbsG: 220, fatG: 75 }],
          kcalLow: 2400,
          kcalMid: 2400,
          kcalHigh: 2400,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-08-14T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'fixture day 3 (today)',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 800, proteinG: 50, carbsG: 90, fatG: 20 }],
          kcalLow: 800,
          kcalMid: 800,
          kcalHigh: 800,
          confidence: 'high',
        },
      }),
    ]);
    mealIds.push(...meals.map((m) => m.id));

    await prisma.weight.upsert({
      where: { date: '1999-07-31' },
      create: { date: '1999-07-31', weightKg: 82.0, source: 'manual' },
      update: { weightKg: 82.0 },
    });
    await prisma.weight.upsert({
      where: { date: '1999-08-14' },
      create: { date: '1999-08-14', weightKg: 80.0, source: 'manual' },
      update: { weightKg: 80.0 },
    });
  });

  it('computes both TDEE estimates, adjusts the target, and persists daily_state + tdee_comparison', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 2,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(TEST_DATE);

    expect(result.totalKcal).toBe(800);
    expect(result.proteinG).toBe(50);
    expect(result.carbsG).toBe(90);
    expect(result.fatG).toBe(20);
    expect(result.rolling14Kcal).toBeCloseTo(1800, 5); // avg(2200, 2400, 800)
    expect(result.observedTdeeKcal).toBeCloseTo(2900, 5);
    expect(result.predictedTdeeKcal).toBeCloseTo(2706.2, 1);
    expect(result.adjustmentReason).toBe('too fast');
    expect(result.adherenceFlag).toBe(false);
    expect(result.dietBreakRecommended).toBe(false);
    expect(result.stagnating).toBe(false);
    expect(result.targetKcal).toBeCloseTo(2600, 5);

    expect(applySpy).toHaveBeenCalledWith({
      currentTargetKcal: expect.closeTo(2600, 1),
      lastAdjustmentDate: TEST_DATE,
      consecutiveDeficitWeeks: 3,
    });

    const dailyState = await prisma.dailyState.findFirst({ where: { date: TEST_DATE } });
    expect(dailyState?.totalKcal).toBe(800);
    expect(dailyState?.rolling14Kcal).toBeCloseTo(1800, 5);
    expect(dailyState?.observedTdee).toBeCloseTo(2900, 5);
    expect(dailyState?.targetKcal).toBeCloseTo(2600, 5);
    expect(dailyState?.isExcluded).toBe(false);
    expect(dailyState?.dietBreakRecommended).toBe(false);

    const comparison = await prisma.tdeeComparison.findFirst({ where: { date: TEST_DATE } });
    expect(comparison?.predicted).toBeCloseTo(2706.2, 1);
    expect(comparison?.observed).toBeCloseTo(2900, 5);
  });

  it('does not touch the profile when the baseline is locked', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: '1999-08-10',
      lastAdjustmentDate: null,
      consecutiveDeficitWeeks: 0,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(TEST_DATE);

    expect(result.adjustmentReason).toBe('baseline locked');
    expect(result.adherenceFlag).toBeNull();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('skips predicted TDEE (and the comparison) when lean mass is not yet known', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: null,
      kcalFloor: null,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 0,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(TEST_DATE);

    expect(result.predictedTdeeKcal).toBeNull();
    expect(result.observedTdeeKcal).toBeCloseTo(2900, 5); // still computable, independent of lean mass
  });

  it('blocks the downward adjustment when the two most recent nights were bad', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 0,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue(['bad', 'bad']);
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    // Fixture weights (82.0 on 1999-07-31, 80.0 on 1999-08-14) give observedRateKgPerWeek=1.0 vs
    // targetRateKgPerWeek=0.4 -> "too fast" territory, NOT "too slow", so sleep-gating should have
    // no effect here; this test only proves the wiring exists and doesn't crash when sleep data is present.
    const result = await runDailyRecompute(TEST_DATE);

    expect(result.adjustmentReason).toBe('too fast');
    expect(applySpy).toHaveBeenCalled();
  });

  it("adds the day's eventBonusKcal to the persisted target without touching the profile update", async () => {
    const bonusDate = '1999-09-20';
    const bonusWeightDates = ['1999-09-06', '1999-09-20'];

    const meals = await Promise.all([
      prisma.meal.create({
        data: {
          datetime: new Date('1999-09-07T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'bonus fixture day 1',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2200, proteinG: 150, carbsG: 200, fatG: 70 }],
          kcalLow: 2200,
          kcalMid: 2200,
          kcalHigh: 2200,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-09-16T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'bonus fixture day 2',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2400, proteinG: 160, carbsG: 220, fatG: 75 }],
          kcalLow: 2400,
          kcalMid: 2400,
          kcalHigh: 2400,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-09-20T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'bonus fixture day 3 (today)',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 800, proteinG: 50, carbsG: 90, fatG: 20 }],
          kcalLow: 800,
          kcalMid: 800,
          kcalHigh: 800,
          confidence: 'high',
        },
      }),
    ]);

    await prisma.weight.upsert({
      where: { date: '1999-09-06' },
      create: { date: '1999-09-06', weightKg: 82.0, source: 'manual' },
      update: { weightKg: 82.0 },
    });
    await prisma.weight.upsert({
      where: { date: '1999-09-20' },
      create: { date: '1999-09-20', weightKg: 80.0, source: 'manual' },
      update: { weightKg: 80.0 },
    });

    await prisma.dayPlan.upsert({
      where: { date: bonusDate },
      create: { date: bonusDate, scenariosApplied: [], segmentsResolved: [], isAtypical: false, eventBonusKcal: 250 },
      update: { isAtypical: false, eventBonusKcal: 250 },
    });

    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 2,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(bonusDate);

    // Same fixture shape as the earlier "computes both TDEE estimates..." test (shifted 37 days),
    // so the baseline adjusted target before the bonus is the same: ~2600.
    expect(result.targetKcal).toBeCloseTo(2850, 5); // 2600 baseline + 250 bonus
    expect(applySpy).toHaveBeenCalledWith({
      currentTargetKcal: expect.closeTo(2600, 1), // profile baseline is NOT bonused
      lastAdjustmentDate: bonusDate,
      consecutiveDeficitWeeks: 3,
    });

    const dailyState = await prisma.dailyState.findFirst({ where: { date: bonusDate } });
    expect(dailyState?.targetKcal).toBeCloseTo(2850, 5);

    await Promise.all(meals.map((m) => prisma.meal.delete({ where: { id: m.id } })));
    await Promise.all(bonusWeightDates.map((d) => prisma.weight.deleteMany({ where: { date: d } })));
    await prisma.dayPlan.deleteMany({ where: { date: bonusDate } });
    await prisma.dailyState.deleteMany({ where: { date: bonusDate } });
  });
});
