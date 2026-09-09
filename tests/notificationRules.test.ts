import { describe, it, expect } from 'vitest';
import {
  ruleDayPlanPrompt,
  ruleWeeklyWeighIn,
  ruleWeeklyReview,
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
