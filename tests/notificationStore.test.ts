import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { countNotificationsToday, hasRuleFiredToday, recordNotificationSent } from '../lib/notificationStore.js';

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
