import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleDefineActivityRoutineTool, handleApplyActivityRoutineTool } from '../lib/activityRoutine.js';
import * as profileLib from '../lib/profile.js';

function baseProfile(weightKg: number | null) {
  return {
    weightKg,
    ratePctPerWeek: 0.5,
    currentTargetKcal: 2500,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('handleDefineActivityRoutineTool', () => {
  afterAll(async () => {
    await prisma.activityRoutine.deleteMany({
      where: { name: { in: ['aller au bureau', 'routine kcal connu', 'incomplet', 'routine sans poids'] } },
    });
  });

  it('computes estimatedKcal and a blended discount from mixed-sport legs via the MET table', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(80));

    const result = await handleDefineActivityRoutineTool({
      name: 'aller au bureau',
      aliases: ['bureau', 'boulot'],
      legs: [
        { sportType: 'cycling', durationMinutes: 10, intensity: 'moderate' },
        { sportType: 'running', durationMinutes: 10, intensity: 'moderate' },
      ],
    });

    // cycling: 6.8*3.5*80/200*10 = 95.2 -> 95 ; running: 9.8*3.5*80/200*10 = 137.2 -> 137 ; total = 232
    // rabais pondéré = (95*0.2 + 137*0.25) / 232 ≈ 0.2295 -> "23%"
    expect(result).toContain('232');
    expect(result).toContain('23%');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'aller au bureau' } });
    expect(routine?.estimatedKcal).toBeCloseTo(232, 0);
    expect(routine?.blendedDiscountPct).toBeCloseTo(0.2295, 3);
    expect(routine?.sampleCount).toBe(0);
    expect(routine?.observedAvgKcal).toBeNull();
  });

  it('accepts a directly known kcal total with a primary sport type', async () => {
    const result = await handleDefineActivityRoutineTool({
      name: 'routine kcal connu',
      aliases: [],
      estimatedKcal: 500,
      primarySportType: 'running',
    });

    expect(result).toContain('500');
    expect(result).toContain('25%');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine kcal connu' } });
    expect(routine?.estimatedKcal).toBe(500);
    expect(routine?.blendedDiscountPct).toBeCloseTo(0.25, 5);
  });

  it('rejects a definition with neither legs nor a known kcal total', async () => {
    const result = await handleDefineActivityRoutineTool({ name: 'incomplet', aliases: [] });
    expect(result).toContain('manque');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'incomplet' } });
    expect(routine).toBeNull();
  });

  it('asks for the missing weight when legs are given without a known weight', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(null));

    const result = await handleDefineActivityRoutineTool({
      name: 'routine sans poids',
      aliases: [],
      legs: [{ sportType: 'cycling', durationMinutes: 10, intensity: 'moderate' }],
    });

    expect(result).toContain('poids');
    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine sans poids' } });
    expect(routine).toBeNull();
  });
});

describe('handleApplyActivityRoutineTool', () => {
  const date1 = '1998-05-10';
  const date2 = '1998-05-11';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date: { in: [date1, date2] } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: [date1, date2] } } });
    await prisma.activityRoutine.deleteMany({ where: { name: 'routine test apply' } });
  });

  it('applies the initial estimate proactively when no reportedKcal is given', async () => {
    await prisma.activityRoutine.create({
      data: {
        name: 'routine test apply',
        aliases: ['rta'],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: [],
      },
    });

    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date1 });

    // bonus = 300 * (1-0.2) = 240
    expect(result).toContain('240');
    expect(result).toContain('anticipation');

    const log = await prisma.activityLog.findFirst({ where: { date: date1, description: 'routine test apply' } });
    expect(log?.status).toBe('planned');
    expect(log?.bonusKcal).toBeCloseTo(240, 5);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: date1 } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(240, 5);

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine test apply' } });
    expect(routine?.sampleCount).toBe(0);
    expect(routine?.observedAvgKcal).toBeNull();
  });

  it('replaces the estimated total with a real reported total and updates the running average', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date1, reportedKcal: 400 });

    // bonus = 400 * (1-0.2) = 320
    expect(result).toContain('320');
    expect(result).toContain('réelle');

    const logs = await prisma.activityLog.findMany({ where: { date: date1, description: 'routine test apply' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('done');
    expect(logs[0].bonusKcal).toBeCloseTo(320, 5);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: date1 } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(320, 5);

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine test apply' } });
    expect(routine?.sampleCount).toBe(1);
    expect(routine?.observedAvgKcal).toBeCloseTo(400, 5);
  });

  it('creates a separate occurrence for a different date and keeps refining the average', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date2, reportedKcal: 500 });

    expect(result).toContain('réelle');

    // running average: (400*1 + 500) / 2 = 450
    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine test apply' } });
    expect(routine?.sampleCount).toBe(2);
    expect(routine?.observedAvgKcal).toBeCloseTo(450, 5);
  });

  it('tells the LLM to create the routine first when the name is unknown', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'routine inconnue xyz', date: date1 });
    expect(result).toContain('Aucune routine');
  });
});
