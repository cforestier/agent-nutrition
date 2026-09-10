import { describe, it, expect, vi } from 'vitest';
import * as claudeLib from '../lib/claude.js';
import {
  ruleDayPlanPrompt,
  ruleWeeklyWeighIn,
  ruleWeeklyReview,
  ruleWeeklyMacroInsight,
  ruleDietBreak,
  ruleNoMealIn24h,
} from '../lib/notificationRules.js';
import type { NotificationContext } from '../lib/notificationRules.js';

const baseCtx: NotificationContext = {
  dateIso: '2026-09-09',
  hourLocal: 8,
  weekday: 'wednesday',
  weighInDay: null,
  reviewDay: null,
  todayWeightLogged: false,
  latestMealAgeHours: 2,
  todayDayPlanConfirmed: true,
  todayWeekdayActivityHint: null,
  latestDailyState: null,
  currentTargetKcal: null,
  weeklyMacros: null,
  recentSleepQualities: [],
};

describe('ruleDayPlanPrompt', () => {
  it('fires in the morning when the day plan is not confirmed', () => {
    const result = ruleDayPlanPrompt({ ...baseCtx, todayDayPlanConfirmed: false });
    expect(result?.rule).toBe('day_plan_prompt');
    expect(result?.message).toContain('Nuit ?');
    expect(result?.buttons).toEqual([
      { text: 'Bonne', callback_data: 'sleep:good' },
      { text: 'Moyenne', callback_data: 'sleep:medium' },
      { text: 'Mauvaise', callback_data: 'sleep:bad' },
    ]);
  });

  it('includes the weekly-default activity hint when known', () => {
    const result = ruleDayPlanPrompt({
      ...baseCtx,
      todayDayPlanConfirmed: false,
      todayWeekdayActivityHint: 'course facile',
    });
    expect(result?.message).toContain('course facile');
  });

  it('does not fire outside the morning window', () => {
    expect(ruleDayPlanPrompt({ ...baseCtx, hourLocal: 15, todayDayPlanConfirmed: false })).toBeNull();
  });

  it('does not fire once the day plan is confirmed', () => {
    expect(ruleDayPlanPrompt({ ...baseCtx, todayDayPlanConfirmed: true })).toBeNull();
  });
});

describe('ruleWeeklyWeighIn', () => {
  it('fires in the morning on the weigh-in day when no weight is logged yet', () => {
    const result = ruleWeeklyWeighIn({ ...baseCtx, weighInDay: 'wednesday', todayWeightLogged: false });
    expect(result?.rule).toBe('weekly_weigh_in');
  });

  it('does not fire on a different weekday', () => {
    expect(ruleWeeklyWeighIn({ ...baseCtx, weighInDay: 'monday' })).toBeNull();
  });

  it('does not fire once already weighed in today', () => {
    expect(ruleWeeklyWeighIn({ ...baseCtx, weighInDay: 'wednesday', todayWeightLogged: true })).toBeNull();
  });
});

describe('ruleWeeklyReview', () => {
  const dailyState = {
    date: '2026-09-08',
    observedTdee: 2900,
    predictedTdee: 2800,
    targetKcal: 2600,
    adherenceFlag: true,
    dietBreakRecommended: false,
  };

  it('fires in the evening on the review day with computed data available', () => {
    const result = ruleWeeklyReview({
      ...baseCtx,
      hourLocal: 19,
      reviewDay: 'wednesday',
      latestDailyState: dailyState,
    });
    expect(result?.rule).toBe('weekly_review');
    expect(result?.message).toContain('2900');
    expect(result?.message).toContain('2600');
  });

  it('does not fire without any computed daily state yet', () => {
    expect(ruleWeeklyReview({ ...baseCtx, hourLocal: 19, reviewDay: 'wednesday', latestDailyState: null })).toBeNull();
  });

  it('does not fire outside the evening window', () => {
    expect(
      ruleWeeklyReview({ ...baseCtx, hourLocal: 9, reviewDay: 'wednesday', latestDailyState: dailyState })
    ).toBeNull();
  });
});

describe('ruleWeeklyMacroInsight', () => {
  const weeklyMacros = {
    proteinTargetMinG: 140,
    proteinTargetMaxG: 154,
    entries: [
      { date: '2026-09-03', totalKcal: 2600, proteinG: 120, carbsG: 260, fatG: 70 },
      { date: '2026-09-04', totalKcal: 2550, proteinG: 115, carbsG: 250, fatG: 65 },
      { date: '2026-09-05', totalKcal: 2500, proteinG: 110, carbsG: 240, fatG: 60 },
    ],
  };

  it("fires in the evening on the review day with enough data, and returns Claude's observation", async () => {
    const converseSpy = vi.spyOn(claudeLib, 'converse').mockResolvedValue({
      text: 'Tes apports en protéines sont un peu bas cette semaine, ce qui peut expliquer la fatigue.',
      outputTokens: 20,
    });

    const result = await ruleWeeklyMacroInsight({
      ...baseCtx,
      hourLocal: 19,
      reviewDay: 'wednesday',
      weeklyMacros,
      recentSleepQualities: ['bad', 'bad', 'medium'],
    });

    expect(result?.rule).toBe('weekly_macro_insight');
    expect(result?.message).toContain('fatigue');
    expect(converseSpy).toHaveBeenCalledOnce();
    const [, messages] = converseSpy.mock.calls[0];
    expect(messages[0].content).toContain('protéines moy. 115');
    expect(messages[0].content).toContain('140-154');
    expect(messages[0].content).toContain('2 mauvaises');
  });

  it('does not fire outside the evening window', async () => {
    const result = await ruleWeeklyMacroInsight({
      ...baseCtx,
      hourLocal: 9,
      reviewDay: 'wednesday',
      weeklyMacros,
      recentSleepQualities: [],
    });
    expect(result).toBeNull();
  });

  it('does not fire on a different weekday', async () => {
    const result = await ruleWeeklyMacroInsight({
      ...baseCtx,
      hourLocal: 19,
      reviewDay: 'monday',
      weeklyMacros,
      recentSleepQualities: [],
    });
    expect(result).toBeNull();
  });

  it('does not fire with fewer than 3 days of data', async () => {
    const result = await ruleWeeklyMacroInsight({
      ...baseCtx,
      hourLocal: 19,
      reviewDay: 'wednesday',
      weeklyMacros: { ...weeklyMacros, entries: weeklyMacros.entries.slice(0, 2) },
      recentSleepQualities: [],
    });
    expect(result).toBeNull();
  });

  it('does not fire when there is no weekly macro data at all', async () => {
    const result = await ruleWeeklyMacroInsight({
      ...baseCtx,
      hourLocal: 19,
      reviewDay: 'wednesday',
      weeklyMacros: null,
      recentSleepQualities: [],
    });
    expect(result).toBeNull();
  });
});

describe('ruleDietBreak', () => {
  it('fires when the most recent daily state recommends a diet break', () => {
    const result = ruleDietBreak({
      ...baseCtx,
      latestDailyState: {
        date: '2026-09-08',
        observedTdee: 2900,
        predictedTdee: 2800,
        targetKcal: 2900,
        adherenceFlag: null,
        dietBreakRecommended: true,
      },
    });
    expect(result?.rule).toBe('diet_break');
    expect(result?.message).toContain('1 à 2 kg');
  });

  it('does not fire otherwise', () => {
    expect(ruleDietBreak({ ...baseCtx, latestDailyState: null })).toBeNull();
  });
});

describe('ruleNoMealIn24h', () => {
  it('fires when no meal has ever been logged', () => {
    expect(ruleNoMealIn24h({ ...baseCtx, latestMealAgeHours: null })?.rule).toBe('no_meal_24h');
  });

  it('fires when the last meal was over 24h ago', () => {
    expect(ruleNoMealIn24h({ ...baseCtx, latestMealAgeHours: 25 })?.rule).toBe('no_meal_24h');
  });

  it('does not fire within 24h of the last meal', () => {
    expect(ruleNoMealIn24h({ ...baseCtx, latestMealAgeHours: 5 })).toBeNull();
  });
});
