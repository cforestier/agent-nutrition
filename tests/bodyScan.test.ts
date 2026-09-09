import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleSetBodyScanTool } from '../lib/bodyScan.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';

describe('handleSetBodyScanTool', () => {
  const testDate = '1999-07-01';
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.bodyScan.delete({ where: { id: createdId } });
  });

  it('bootstraps the initial target when none exists yet', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: null,
      leanMassKg: null,
      kcalFloor: null,
      baselineStartedAt: null,
      lastAdjustmentDate: null,
      consecutiveDeficitWeeks: 0,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    const applySpy = vi.spyOn(profileLib, 'applyBodyScanToProfile').mockResolvedValue();

    const result = await handleSetBodyScanTool({
      date: testDate,
      weightKg: 82,
      leanMassKg: 65,
    });

    expect(result).toContain('1950'); // kcalFloor = max(1800, 65*30)
    expect(result).toContain('2266'); // bootstrapped target, see calc below

    const saved = await prisma.bodyScan.findFirst({ where: { date: testDate } });
    createdId = saved?.id;
    expect(saved?.leanMassKg).toBe(65);
    expect(saved?.weightKg).toBe(82);
    expect(saved?.source).toBe('manual');

    expect(applySpy).toHaveBeenCalledWith({
      leanMassKg: 65,
      kcalFloor: 1950,
      currentTargetKcal: expect.closeTo(2266.2, 1),
    });
  });

  it('does not bootstrap a target when one already exists', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2600,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-06-20',
      consecutiveDeficitWeeks: 1,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    const applySpy = vi.spyOn(profileLib, 'applyBodyScanToProfile').mockResolvedValue();

    await handleSetBodyScanTool({ date: `${testDate}-again`, weightKg: 81, leanMassKg: 66 });

    expect(applySpy).toHaveBeenCalledWith({
      leanMassKg: 66,
      kcalFloor: 1980,
      currentTargetKcal: undefined,
    });

    const saved = await prisma.bodyScan.findFirst({ where: { date: `${testDate}-again` } });
    if (saved) await prisma.bodyScan.delete({ where: { id: saved.id } });
  });
});
