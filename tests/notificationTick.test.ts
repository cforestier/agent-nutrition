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
      { date: '1999-09-03', totalKcal: 2600, proteinG: 120, carbsG: 260, fatG: 70 },
      { date: '1999-09-04', totalKcal: 2550, proteinG: 115, carbsG: 250, fatG: 65 },
      { date: '1999-09-05', totalKcal: 2500, proteinG: 110, carbsG: 240, fatG: 60 },
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
});
