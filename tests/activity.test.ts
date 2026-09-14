import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogActivityTool, lookupMet, metToKcal, recomputeEventBonusForDate } from '../lib/activity.js';
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
  const dates = ['1999-07-05', '1999-07-06', '1999-07-07', '1999-07-08', '1999-07-09', '1999-07-10', '1999-07-11', '1999-07-12', '1999-07-13', '1999-07-14'];

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
    // `isAtypical` is owned by apply_day_plan, never derived from an activity bonus: the row is
    // freshly created here by the upsert, so it keeps the schema default.
    expect(dayPlan?.isAtypical).toBe(false);
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

    expect(result).toContain('trop faible');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[2] } });
    expect(log?.bonusKcal).toBe(0);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[2] } });
    expect(dayPlan?.eventBonusKcal).toBe(0);
    expect(dayPlan?.isAtypical).toBe(false);
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

  it('estimates calories from duration + intensity via the MET table when no device data is given', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500)); // weightKg: 80
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[4],
      description: 'vélo chez un ami, pas de montre',
      sportType: 'cycling',
      durationMinutes: 40,
      intensity: 'moderate',
      relationToPlan: 'additional',
    });

    // met = 6.8; kcal = 6.8 * 3.5 * 80 / 200 * 40 = 380.8 -> rounded 381
    expect(result).toContain('381');
    expect(result).toContain('estimées');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[4] } });
    expect(log?.reportedCalories).toBeCloseTo(381, 5);
    expect(log?.estimationMethod).toBe('met_estimate');
    expect(log?.metUsed).toBeCloseTo(6.8, 5);
    expect(log?.intensity).toBe('moderate');
    expect(log?.durationMinutes).toBeCloseTo(40, 5);
  });

  it('rejects a MET estimate when the sport type has no MET table entry', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[5],
      description: 'séance muscu sans montre',
      sportType: 'strength',
      durationMinutes: 45,
      intensity: 'moderate',
      relationToPlan: 'additional',
    });

    expect(result).toContain('Aucune table');
    const log = await prisma.activityLog.findFirst({ where: { date: dates[5] } });
    expect(log).toBeNull();
  });

  it('asks for the missing weight before estimating from duration + intensity', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500) as any).mockResolvedValueOnce({
      ...baseProfile(2500),
      weightKg: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[6],
      description: 'crossfit chez un ami',
      sportType: 'crossfit',
      durationMinutes: 30,
      intensity: 'vigorous',
      relationToPlan: 'additional',
    });

    expect(result).toContain('poids');
    const log = await prisma.activityLog.findFirst({ where: { date: dates[6] } });
    expect(log).toBeNull();
  });

  it('estimates walking calories via the MET table', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[7],
      description: "marche jusqu'à la gare",
      sportType: 'walking',
      durationMinutes: 15,
      intensity: 'moderate',
      relationToPlan: 'additional',
    });

    // met = 3.5 ; kcal = 3.5 * 3.5 * 80 / 200 * 15 = 73.5 -> 74 ; rabais other 35% -> 74*0.65=48.1 < seuil 100
    expect(result).toContain('74');
    expect(result).toContain('trop faible');
  });

  it('sums bonuses across multiple activities logged the same day instead of overwriting', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    await handleLogActivityTool({
      date: dates[8],
      description: 'vélo du matin',
      sportType: 'cycling',
      reportedCalories: 400,
      relationToPlan: 'additional',
    });
    await handleLogActivityTool({
      date: dates[8],
      description: 'course du midi',
      sportType: 'running',
      reportedCalories: 300,
      relationToPlan: 'additional',
    });

    // bonus1 = 400*(1-0.2)=320 ; bonus2 = 300*(1-0.25)=225
    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[8] } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(320 + 225, 5);
  });

  it('logs a planned (not-yet-done) activity ahead of time, applying the bonus proactively', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[9],
      description: 'course prévue à midi',
      sportType: 'running',
      durationMinutes: 30,
      intensity: 'moderate',
      relationToPlan: 'additional',
      status: 'planned',
      plannedTime: '12:00',
    });

    expect(result).toContain('estimées');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[9] } });
    expect(log?.status).toBe('planned');
    expect(log?.plannedTime).toBe('12:00');
  });

  it('updates the same planned entry in place when confirmed later instead of duplicating it', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    await handleLogActivityTool({
      date: dates[9],
      description: 'course confirmée',
      sportType: 'running',
      reportedCalories: 350,
      relationToPlan: 'additional',
    });

    const logs = await prisma.activityLog.findMany({ where: { date: dates[9], sportType: 'running' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('done');
    expect(logs[0].reportedCalories).toBe(350);
  });
});

describe('metToKcal / lookupMet', () => {
  it('computes kcal from a MET value, duration, and weight', () => {
    expect(metToKcal(6.8, 40, 80)).toBeCloseTo(381, 0);
  });

  it('returns undefined for an unknown sport/intensity pair', () => {
    expect(lookupMet('strength', 'moderate')).toBeUndefined();
  });

  it('looks up the new walking MET table', () => {
    expect(lookupMet('walking', 'light')).toBe(2.8);
  });
});

describe('recomputeEventBonusForDate', () => {
  const date = '1998-05-01';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date } });
    await prisma.dayPlan.deleteMany({ where: { date } });
  });

  it('sums bonusKcal across all ActivityLog rows for the date', async () => {
    await prisma.activityLog.createMany({
      data: [
        { date, description: 'a', sportType: 'cycling', reportedCalories: 100, relationToPlan: 'additional', baselineKcal: 0, rawDiffKcal: 100, discountPct: 0, bonusKcal: 150 },
        { date, description: 'b', sportType: 'running', reportedCalories: 100, relationToPlan: 'additional', baselineKcal: 0, rawDiffKcal: 100, discountPct: 0, bonusKcal: 50 },
      ],
    });

    await recomputeEventBonusForDate(date);

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBe(200);
    // Summing a non-zero bonus must NOT flag the day atypical — that field stays untouched
    // (schema default on this freshly-upserted row) so the day still feeds the 14-day average.
    expect(dayPlan?.isAtypical).toBe(false);
  });

  it('leaves an existing apply_day_plan-owned isAtypical flag untouched', async () => {
    await prisma.dayPlan.update({ where: { date }, data: { isAtypical: true } });

    await prisma.activityLog.create({
      data: { date, description: 'petite marche', sportType: 'walking', reportedCalories: 50, relationToPlan: 'additional', baselineKcal: 0, rawDiffKcal: 50, discountPct: 0, bonusKcal: 0 },
    });
    await recomputeEventBonusForDate(date);

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.isAtypical).toBe(true); // not silently cleared by a sub-threshold activity
    expect(dayPlan?.eventBonusKcal).toBe(200);
  });

  it('excludes cancelled rows from the summed bonus', async () => {
    const log = await prisma.activityLog.findFirst({ where: { date, bonusKcal: 150 } });
    await prisma.activityLog.update({ where: { id: log!.id }, data: { status: 'cancelled' } });

    await recomputeEventBonusForDate(date);

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBe(50);
  });
});

describe('recomputeEventBonusForDate with legacy rows', () => {
  const date = '1997-03-03';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date } });
    await prisma.dayPlan.deleteMany({ where: { date } });
  });

  // A document written before the `status` field existed physically lacks it in MongoDB. Prisma
  // applies the schema default (`done`) on read, but a `where: { status: ... }` clause is pushed
  // down to Mongo and would silently drop such a row from the bonus sum.
  it('still counts a document that physically lacks the status field', async () => {
    await prisma.$runCommandRaw({
      insert: 'ActivityLog',
      documents: [
        {
          date,
          description: 'legacy row without status',
          sportType: 'cycling',
          reportedCalories: 300,
          relationToPlan: 'additional',
          baselineKcal: 0,
          rawDiffKcal: 300,
          discountPct: 0.2,
          bonusKcal: 240,
          createdAt: { $date: '1997-03-03T10:00:00Z' },
        },
      ],
    });

    await recomputeEventBonusForDate(date);

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(240, 5);
  });
});
