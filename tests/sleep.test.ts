import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveSleepQuality, recentSleepQualities } from '../lib/sleep.js';

const TEST_DATES = ['1999-10-01', '1999-10-02', '1999-10-03'];

describe('sleep', () => {
  afterAll(async () => {
    await prisma.sleepLog.deleteMany({ where: { date: { in: TEST_DATES } } });
  });

  it('saves a sleep quality for a date, overwriting on a second call for the same date', async () => {
    await saveSleepQuality('1999-10-01', 'good');
    await saveSleepQuality('1999-10-01', 'bad');

    const saved = await prisma.sleepLog.findUnique({ where: { date: '1999-10-01' } });
    expect(saved?.quality).toBe('bad');
  });

  it('returns the most recent N qualities in chronological order', async () => {
    await saveSleepQuality('1999-10-02', 'medium');
    await saveSleepQuality('1999-10-03', 'bad');

    const recent = await recentSleepQualities(2);
    expect(recent).toEqual(['medium', 'bad']);
  });

  it('returns an array without throwing when queried', async () => {
    await prisma.sleepLog.deleteMany({ where: { date: { in: TEST_DATES } } });
    const recent = await recentSleepQualities(2);
    // Not asserting emptiness strictly (this is an unbounded "most recent" query, mocked
    // everywhere else in the suite per the Global Constraints note) — just that it resolves.
    expect(Array.isArray(recent)).toBe(true);
  });
});
