import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import {
  countNotificationsToday,
  hasRuleFiredToday,
  recordNotificationSent,
  getRecentDailyStates,
} from '../lib/notificationStore.js';

const TEST_DATE = '1999-09-10';

describe('notificationStore', () => {
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { date: TEST_DATE } });
  });

  it('starts at zero sent and no rule fired', async () => {
    expect(await countNotificationsToday(TEST_DATE)).toBe(0);
    expect(await hasRuleFiredToday(TEST_DATE, 'no_meal_24h')).toBe(false);
  });

  it('records a sent notification, reflected in both the count and the per-rule check', async () => {
    await recordNotificationSent(TEST_DATE, 'no_meal_24h');

    expect(await countNotificationsToday(TEST_DATE)).toBe(1);
    expect(await hasRuleFiredToday(TEST_DATE, 'no_meal_24h')).toBe(true);
    expect(await hasRuleFiredToday(TEST_DATE, 'weekly_weigh_in')).toBe(false);
  });
});

describe('getRecentDailyStates', () => {
  const dateA = '2099-06-16';
  const dateB = '2099-06-17';

  afterAll(async () => {
    await prisma.dailyState.deleteMany({ where: { date: { in: [dateA, dateB] } } });
  });

  it('returns entries ordered by date ascending, with macro fields', async () => {
    await prisma.dailyState.create({ data: { date: dateB, totalKcal: 2500, proteinG: 140, carbsG: 250, fatG: 70 } });
    await prisma.dailyState.create({ data: { date: dateA, totalKcal: 2400, proteinG: 130, carbsG: 240, fatG: 65 } });

    const result = await getRecentDailyStates(2);

    expect(result).toEqual([
      { date: dateA, totalKcal: 2400, proteinG: 130, carbsG: 240, fatG: 65 },
      { date: dateB, totalKcal: 2500, proteinG: 140, carbsG: 250, fatG: 70 },
    ]);
  });
});
