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

  it('keeps the morning estimate visible (superseded) and logs the real total as a separate row', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date1, reportedKcal: 400 });

    // bonus = 400 * (1-0.2) = 320
    expect(result).toContain('320');
    expect(result).toContain('réelle');

    const logs = await prisma.activityLog.findMany({
      where: { date: date1, description: 'routine test apply' },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(2);
    expect(logs[0].status).toBe('superseded');
    expect(logs[0].bonusKcal).toBeCloseTo(240, 5); // original estimate, kept for comparison
    expect(logs[1].status).toBe('done');
    expect(logs[1].bonusKcal).toBeCloseTo(320, 5);

    // Only the `done` row's bonus counts toward the day's target — not double-counted with the
    // superseded estimate it replaced.
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

  it('rejects a real occurrence dated after today, before even looking up the routine', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await handleApplyActivityRoutineTool({
      routineName: 'routine inconnue xyz', // deliberately unknown: the date check must fire first
      date: tomorrow,
      reportedKcal: 65,
    });

    expect(result).toContain('futur');
    expect(result).not.toContain('Aucune routine');
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

  it('replaces the done sample in place on a second correction, keeping the superseded estimate untouched', async () => {
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
    await handleApplyActivityRoutineTool({ routineName: 'rtc', date, reportedKcal: 450 }); // confirmed -> superseded + done

    const afterConfirm = await prisma.activityRoutine.findFirst({ where: { name: routineName } });
    expect(afterConfirm?.sampleCount).toBe(1);
    expect(afterConfirm?.observedAvgKcal).toBeCloseTo(450, 5);

    // "en fait 500, pas 450" — corrects the already-confirmed `done` row, not the superseded estimate.
    await handleApplyActivityRoutineTool({ routineName: 'rtc', date, reportedKcal: 500 });

    const logs = await prisma.activityLog.findMany({ where: { date }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0].status).toBe('superseded');
    expect(logs[0].reportedCalories).toBeCloseTo(300, 5); // original estimate, unaffected by the correction
    expect(logs[1].status).toBe('done');
    expect(logs[1].reportedCalories).toBeCloseTo(500, 5);

    const afterCorrection = await prisma.activityRoutine.findFirst({ where: { name: routineName } });
    expect(afterCorrection?.sampleCount).toBe(1); // NOT incremented a second time
    expect(afterCorrection?.observedAvgKcal).toBeCloseTo(500, 5); // replaced, not averaged in twice

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(400, 5); // 500 * (1 - 0.2), not double-counted with the superseded estimate
  });
});

describe('handleApplyActivityRoutineTool — cumulative legs reported across separate messages', () => {
  const date = '1998-06-03';
  const routineName = 'routine test cumulative';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date } });
    await prisma.dayPlan.deleteMany({ where: { date } });
    await prisma.activityRoutine.deleteMany({ where: { name: routineName } });
  });

  it('adds each leg to the running total instead of replacing it', async () => {
    await prisma.activityRoutine.create({
      data: {
        name: routineName,
        aliases: ['rtcum'],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: [],
      },
    });

    await handleApplyActivityRoutineTool({ routineName: 'rtcum', date }); // proactive -> planned
    // Morning leg: vélo jusqu'à la gare. Nothing to add to yet, so this behaves like a normal
    // first confirmation (not the cumulative message) — bonus = 65 * (1 - 0.2) = 52.
    const first = await handleApplyActivityRoutineTool({ routineName: 'rtcum', date, reportedKcal: 65, cumulative: true });
    expect(first).toContain('52');

    const afterFirstLeg = await prisma.activityLog.findMany({ where: { date }, orderBy: { createdAt: 'asc' } });
    expect(afterFirstLeg).toHaveLength(2);
    expect(afterFirstLeg[0].status).toBe('superseded');
    expect(afterFirstLeg[1].status).toBe('done');
    expect(afterFirstLeg[1].reportedCalories).toBeCloseTo(65, 5); // nothing to add to yet

    // Evening leg: retour.
    const second = await handleApplyActivityRoutineTool({ routineName: 'rtcum', date, reportedKcal: 90, cumulative: true });
    expect(second).toContain('+90');
    expect(second).toContain('155'); // running total for the day

    const afterSecondLeg = await prisma.activityLog.findMany({ where: { date }, orderBy: { createdAt: 'asc' } });
    expect(afterSecondLeg).toHaveLength(2); // still one `done` row, updated in place — not a third row
    expect(afterSecondLeg[0].status).toBe('superseded');
    expect(afterSecondLeg[0].reportedCalories).toBeCloseTo(300, 5); // estimate untouched
    expect(afterSecondLeg[1].status).toBe('done');
    expect(afterSecondLeg[1].reportedCalories).toBeCloseTo(155, 5);
    expect(afterSecondLeg[1].bonusKcal).toBeCloseTo(124, 5); // 155 * (1 - 0.2)

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(124, 5); // superseded estimate excluded

    const routine = await prisma.activityRoutine.findFirst({ where: { name: routineName } });
    expect(routine?.sampleCount).toBe(1); // still one occurrence for the day, not two samples
    expect(routine?.observedAvgKcal).toBeCloseTo(155, 5);
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
