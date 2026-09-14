import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import {
  handleDefineActivityRoutineTool,
  handleApplyActivityRoutineTool,
  autoApplyRoutineForToday,
  cancelPlannedActivity,
  getDueRoutinesToday,
  buildRoutineSystemPromptAddition,
} from '../lib/activityRoutine.js';
import { weekdayOf } from '../lib/dateUtils.js';
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

describe('handleDefineActivityRoutineTool — reachable error paths', () => {
  const duplicateName = 'routine doublon test';
  const emptyLegsName = 'routine legs vides';

  afterAll(async () => {
    await prisma.activityRoutine.deleteMany({ where: { name: { in: [duplicateName, emptyLegsName] } } });
  });

  it('returns a friendly message instead of letting Prisma throw on a duplicate name', async () => {
    await prisma.activityRoutine.create({
      data: {
        name: duplicateName,
        aliases: [],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: [],
      },
    });

    const result = await handleDefineActivityRoutineTool({
      name: duplicateName,
      aliases: [],
      estimatedKcal: 400,
      primarySportType: 'running',
    });

    expect(result).toContain('existe déjà');

    const routines = await prisma.activityRoutine.findMany({ where: { name: duplicateName } });
    expect(routines).toHaveLength(1);
    expect(routines[0].estimatedKcal).toBe(300); // untouched
  });

  it('treats an empty legs array as missing input instead of throwing', async () => {
    const result = await handleDefineActivityRoutineTool({ name: emptyLegsName, aliases: [], legs: [] });

    expect(result).toContain('manque');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: emptyLegsName } });
    expect(routine).toBeNull();
  });
});

describe('handleApplyActivityRoutineTool — correcting an already-confirmed occurrence', () => {
  const date = '1998-06-02';
  const routineName = 'routine test correction';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date } });
    await prisma.dayPlan.deleteMany({ where: { date } });
    await prisma.activityRoutine.deleteMany({ where: { name: routineName } });
  });

  it('replaces the sample in place instead of creating a second done row', async () => {
    await prisma.activityRoutine.create({
      data: {
        name: routineName,
        aliases: ['rtc'],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: [],
      },
    });

    await handleApplyActivityRoutineTool({ routineName: 'rtc', date }); // proactive -> planned
    await handleApplyActivityRoutineTool({ routineName: 'rtc', date, reportedKcal: 450 }); // confirmed -> done

    const afterConfirm = await prisma.activityRoutine.findFirst({ where: { name: routineName } });
    expect(afterConfirm?.sampleCount).toBe(1);
    expect(afterConfirm?.observedAvgKcal).toBeCloseTo(450, 5);

    // "en fait 500, pas 450"
    await handleApplyActivityRoutineTool({ routineName: 'rtc', date, reportedKcal: 500 });

    const logs = await prisma.activityLog.findMany({ where: { date } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('done');
    expect(logs[0].reportedCalories).toBeCloseTo(500, 5);

    const afterCorrection = await prisma.activityRoutine.findFirst({ where: { name: routineName } });
    expect(afterCorrection?.sampleCount).toBe(1); // NOT incremented a second time
    expect(afterCorrection?.observedAvgKcal).toBeCloseTo(500, 5); // replaced, not averaged in twice

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(400, 5); // 500 * (1 - 0.2), not double-counted
  });
});

describe('cancelPlannedActivity', () => {
  const date = '1998-06-01';
  const routineName = 'routine test cancel';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date } });
    await prisma.dayPlan.deleteMany({ where: { date } });
    await prisma.activityRoutine.deleteMany({ where: { name: routineName } });
  });

  it('marks the row cancelled, zeroes the bonus, and keeps the routine off the due list', async () => {
    const routine = await prisma.activityRoutine.create({
      data: {
        name: routineName,
        aliases: [],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: [weekdayOf(date)],
      },
    });

    const { activityLogId } = await autoApplyRoutineForToday(routine, date);

    const dayPlanBefore = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlanBefore?.eventBonusKcal).toBeCloseTo(240, 5); // 300 * (1 - 0.2)

    const cancelled = await cancelPlannedActivity(activityLogId);
    expect(cancelled).toBe(true);

    const log = await prisma.activityLog.findUnique({ where: { id: activityLogId } });
    expect(log).not.toBeNull(); // kept as an explicit record of the user's decision
    expect(log?.status).toBe('cancelled');

    const dayPlanAfter = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlanAfter?.eventBonusKcal).toBe(0);

    // The next 15-minute tick must not see this routine as due again.
    const due = await getDueRoutinesToday(weekdayOf(date), date);
    expect(due.map((r) => r.id)).not.toContain(routine.id);
  });
});

describe('buildRoutineSystemPromptAddition', () => {
  const routineName = 'routine prompt test';

  afterAll(async () => {
    await prisma.activityRoutine.deleteMany({ where: { name: routineName } });
  });

  it('lists every known routine with its aliases and recurring weekdays', async () => {
    await prisma.activityRoutine.create({
      data: {
        name: routineName,
        aliases: ['rpt'],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: ['monday'],
      },
    });

    const addition = await buildRoutineSystemPromptAddition();

    expect(addition).toContain(routineName);
    expect(addition).toContain('rpt');
    expect(addition).toContain('monday');
    expect(addition).toContain('apply_activity_routine');
  });
});
