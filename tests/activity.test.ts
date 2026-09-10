import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogActivityTool } from '../lib/activity.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';

function baseProfile(currentTargetKcal: number | null) {
  return {
    weightKg: 80,
    ratePctPerWeek: 0.5,
    currentTargetKcal,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('handleLogActivityTool', () => {
  const dates = ['1999-07-05', '1999-07-06', '1999-07-07', '1999-07-08'];

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date: { in: dates } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: dates } } });
  });

  it('replaces a planned session and adds the discounted excess above threshold', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 300, activityType: 'course facile' });

    const result = await handleLogActivityTool({
      date: dates[0],
      description: 'vélo aller-retour gare',
      sportType: 'cycling',
      reportedCalories: 700,
      relationToPlan: 'replaces',
    });

    // rawDiff = 700 - 300 = 400; discounted = 400 * (1 - 0.20) = 320; |320| >= 100 -> bonus = 320
    expect(result).toContain('320');
    expect(result).toContain('2820'); // 2500 + 320

    const log = await prisma.activityLog.findFirst({ where: { date: dates[0] } });
    expect(log?.rawDiffKcal).toBeCloseTo(400, 5);
    expect(log?.discountPct).toBeCloseTo(0.2, 5);
    expect(log?.bonusKcal).toBeCloseTo(320, 5);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[0] } });
    expect(dayPlan?.isAtypical).toBe(true);
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(320, 5);
  });

  it('treats an additional activity as pure upside with no baseline subtraction', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 300, activityType: 'course facile' });

    const result = await handleLogActivityTool({
      date: dates[1],
      description: 'séance muscu du soir',
      sportType: 'strength',
      reportedCalories: 200,
      relationToPlan: 'additional',
    });

    // rawDiff = 200 (no baseline subtracted); discounted = 200 * (1 - 0.30) = 140; >= 100 -> bonus = 140
    expect(result).toContain('140');

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[1] } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(140, 5);
  });

  it('does not adjust the target when the discounted gap is below the materiality threshold', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 300, activityType: 'course facile' });

    const result = await handleLogActivityTool({
      date: dates[2],
      description: 'course facile comme prévu',
      sportType: 'running',
      reportedCalories: 350,
      relationToPlan: 'replaces',
    });

    // rawDiff = 350 - 300 = 50; discounted = 50 * (1 - 0.25) = 37.5; < 100 -> bonus = 0
    expect(result).toContain('trop faible');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[2] } });
    expect(log?.bonusKcal).toBe(0);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[2] } });
    expect(dayPlan).toBeNull();
  });

  it('reduces the target when the actual effort was well below what was planned', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 500, activityType: 'sortie longue' });

    const result = await handleLogActivityTool({
      date: dates[3],
      description: 'sortie écourtée',
      sportType: 'other',
      reportedCalories: 100,
      relationToPlan: 'replaces',
    });

    // rawDiff = 100 - 500 = -400; discounted = -400 * (1 - 0.35) = -260; |260| >= 100 -> bonus = -260
    expect(result).toContain('-260');
    expect(result).toContain('2240'); // 2500 - 260

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[3] } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(-260, 5);
  });
});
