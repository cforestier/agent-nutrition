import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { runNotificationTick } from '../lib/notificationTick.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';
import * as notificationStoreLib from '../lib/notificationStore.js';
import * as telegramLib from '../lib/telegram.js';
import * as sleepLib from '../lib/sleep.js';
import * as claudeLib from '../lib/claude.js';

const TEST_DATE = '1999-09-05';

function baseProfile() {
  return {
    weightKg: 80,
    ratePctPerWeek: 0.5,
    currentTargetKcal: 2600,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('runNotificationTick', () => {
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { date: TEST_DATE } });
    await prisma.dayPlan.deleteMany({ where: { date: TEST_DATE } });
    await prisma.weight.deleteMany({ where: { date: TEST_DATE } });
    await prisma.activityLog.deleteMany({ where: { date: { in: ['1998-04-06', '1998-04-13', '1998-04-20', '1998-04-21'] } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: ['1998-04-06', '1998-04-13', '1998-04-20', '1998-04-21'] } } });
    await prisma.notification.deleteMany({ where: { date: { in: ['1998-04-06', '1998-04-13', '1998-04-20', '1998-04-21'] } } });
    await prisma.activityRoutine.deleteMany({ where: { name: { in: ['aller au bureau test', 'routine déjà loggée'] } } });
  });

  it('sends nothing and skips entirely during quiet hours', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    const result = await runNotificationTick(new Date('1999-09-05T23:30:00Z'), 12345);

    expect(result.skippedQuietHours).toBe(true);
    expect(result.sent).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends the day-plan prompt (with sleep buttons) in the morning when nothing else is set up', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessageWithKeyboard').mockResolvedValue();

    const result = await runNotificationTick(new Date('1999-09-05T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toEqual(['day_plan_prompt']);
    expect(sendSpy).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("prévu aujourd'hui"),
      expect.arrayContaining([{ text: 'Bonne', callback_data: 'sleep:good' }])
    );

    const recorded = await prisma.notification.findUnique({
      where: { date_rule: { date: TEST_DATE, rule: 'day_plan_prompt' } },
    });
    expect(recorded).not.toBeNull();
  });

  it('does not fire the same rule twice on the same day', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    // day_plan_prompt already recorded by the previous test for this same TEST_DATE.
    const result = await runNotificationTick(new Date('1999-09-05T07:00:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).not.toContain('day_plan_prompt');
    expect(sendSpy).not.toHaveBeenCalledWith(12345, expect.stringContaining('prévu'));
  });

  it('stops once the daily cap is reached', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    vi.spyOn(notificationStoreLib, 'countNotificationsToday').mockResolvedValue(4);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    const result = await runNotificationTick(new Date('1999-09-05T07:00:00Z'), 12345);

    expect(result.sent).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends the weekly macro insight on the review day evening when enough data is available', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({ ...baseProfile(), reviewDay: 'sunday' });
    vi.spyOn(notificationStoreLib, 'countNotificationsToday').mockResolvedValue(0);
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T18:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([
      { date: '1999-09-03', totalKcal: 2600, proteinG: 120, carbsG: 260, fatG: 70, targetKcal: 2600, observedTdee: 2700 },
      { date: '1999-09-04', totalKcal: 2550, proteinG: 115, carbsG: 250, fatG: 65, targetKcal: 2600, observedTdee: 2700 },
      { date: '1999-09-05', totalKcal: 2500, proteinG: 110, carbsG: 240, fatG: 60, targetKcal: 2600, observedTdee: 2700 },
    ]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue(['bad', 'bad', 'medium']);
    vi.spyOn(claudeLib, 'converse').mockResolvedValue({
      text: 'Tes protéines sont un peu basses cette semaine, ce qui peut jouer sur ta fatigue.',
      outputTokens: 15,
    });
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    // 1999-09-05 18:00 UTC is a Sunday evening in Zurich time.
    const result = await runNotificationTick(new Date('1999-09-05T18:00:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toContain('weekly_macro_insight');
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('fatigue'));

    const recorded = await prisma.notification.findUnique({
      where: { date_rule: { date: TEST_DATE, rule: 'weekly_macro_insight' } },
    });
    expect(recorded).not.toBeNull();
  });

  it('auto-applies a due recurring routine, sends a confirm/cancel prompt, and creates the planned ActivityLog', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1998-04-06T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();
    const sendKeyboardSpy = vi.spyOn(telegramLib, 'sendMessageWithKeyboard').mockResolvedValue();

    const routine = await prisma.activityRoutine.create({
      data: {
        name: 'aller au bureau test',
        aliases: [],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: ['monday'], // 1998-04-06 est un lundi
      },
    });

    const result = await runNotificationTick(new Date('1998-04-06T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toContain(`routine_auto_apply:${routine.id}`);
    expect(sendKeyboardSpy).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('aller au bureau test'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Confirmer' }),
        expect.objectContaining({ text: "Pas aujourd'hui" }),
      ])
    );

    const log = await prisma.activityLog.findFirst({ where: { date: '1998-04-06', routineId: routine.id } });
    expect(log?.status).toBe('planned');
    expect(log?.bonusKcal).toBeCloseTo(240, 5); // 300 * (1-0.2)

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: '1998-04-06' } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(240, 5);
  });

  it('does not re-apply a routine that already has a log for today', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1998-04-13T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();
    vi.spyOn(telegramLib, 'sendMessageWithKeyboard').mockResolvedValue();

    // The previous test's routine ("aller au bureau test", recurringWeekdays: ['monday']) has no
    // ActivityLog for this test's date (1998-04-13), so it would otherwise also show up as "due"
    // here and get auto-applied ahead of this test's routine. Only afterAll normally cleans it up
    // (deliberately, so a mid-test assertion failure doesn't skip cleanup), so remove it explicitly
    // here to keep this test's own scenario isolated.
    await prisma.activityRoutine.deleteMany({ where: { name: 'aller au bureau test' } });

    const routine = await prisma.activityRoutine.create({
      data: {
        name: 'routine déjà loggée',
        aliases: [],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: ['monday'], // 1998-04-13 est aussi un lundi
      },
    });
    await prisma.activityLog.create({
      data: {
        date: '1998-04-13',
        description: routine.name,
        sportType: 'other',
        reportedCalories: 300,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: 300,
        discountPct: 0.2,
        bonusKcal: 240,
        routineId: routine.id,
        status: 'done',
      },
    });

    const result = await runNotificationTick(new Date('1998-04-13T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('routine_auto_apply')])
    );
  });

  it('warns about fueling before a long/intense session planned within the next few hours', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    const activity = await prisma.activityLog.create({
      data: {
        date: '1998-04-20',
        description: 'Sortie vélo longue',
        sportType: 'cycling',
        reportedCalories: 600,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: 600,
        discountPct: 0.2,
        bonusKcal: 480,
        durationMinutes: 90,
        status: 'planned',
        plannedTime: '13:00', // 1998-04-20T09:30:00Z is 11:30 Zurich time (CEST) — 1.5h ahead
      },
    });

    // 1998-04-20T09:30:00Z is a Monday 11:30 in Zurich (CEST), outside the morning day-plan window.
    const result = await runNotificationTick(new Date('1998-04-20T09:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toContain(`fuel_pre_effort:${activity.id}`);
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('Sortie vélo longue'));
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('glucides bas'));
  });

  it('reminds to refuel after a long/intense session confirmed recently with no meal logged since', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    const activity = await prisma.activityLog.create({
      data: {
        date: '1998-04-21',
        description: 'Sortie course longue',
        sportType: 'running',
        reportedCalories: 700,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: 700,
        discountPct: 0.25,
        bonusKcal: 525,
        durationMinutes: 90,
        status: 'done',
        createdAt: new Date('1998-04-21T08:30:00Z'), // 1h before the tick below
      },
    });

    // 1998-04-21T09:30:00Z is a Tuesday 11:30 in Zurich (CEST).
    const result = await runNotificationTick(new Date('1998-04-21T09:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toContain(`refuel_post_effort:${activity.id}`);
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('Sortie course longue'));
  });
});
