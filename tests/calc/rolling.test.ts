import { describe, it, expect } from 'vitest';
import {
  averageOf,
  excludeAtypical,
  fourteenDayAverageKcal,
  sevenDayAverageWeight,
  daysSince,
} from '../../lib/calc/rolling.js';
import type { DailyIntake } from '../../lib/calc/rolling.js';

describe('averageOf', () => {
  it('averages a list of numbers', () => {
    expect(averageOf([2000, 2200, 2100])).toBe(2100);
  });

  it('throws on an empty array', () => {
    expect(() => averageOf([])).toThrow('averageOf: empty array');
  });
});

describe('excludeAtypical', () => {
  it('filters out entries marked atypical', () => {
    const intakes: DailyIntake[] = [
      { date: '2026-09-01', kcal: 2000, isAtypical: false },
      { date: '2026-09-02', kcal: 3500, isAtypical: true },
      { date: '2026-09-03', kcal: 2100, isAtypical: false },
    ];
    expect(excludeAtypical(intakes)).toEqual([
      { date: '2026-09-01', kcal: 2000, isAtypical: false },
      { date: '2026-09-03', kcal: 2100, isAtypical: false },
    ]);
  });
});

describe('fourteenDayAverageKcal', () => {
  it('averages kcal after removing atypical days', () => {
    const intakes: DailyIntake[] = [
      { date: '2026-09-01', kcal: 2000, isAtypical: false },
      { date: '2026-09-02', kcal: 4000, isAtypical: true },
      { date: '2026-09-03', kcal: 2200, isAtypical: false },
    ];
    expect(fourteenDayAverageKcal(intakes)).toBe(2100);
  });
});

describe('sevenDayAverageWeight', () => {
  it('averages a window of weights', () => {
    expect(sevenDayAverageWeight([80, 79.5, 79.8, 79.2, 79.6, 79.1, 79.3])).toBeCloseTo(79.5, 5);
  });
});

describe('daysSince', () => {
  it('counts whole days between two UTC dates', () => {
    expect(daysSince('2026-01-01', '2026-01-10')).toBe(9);
  });

  it('returns 0 for the same date', () => {
    expect(daysSince('2026-01-01', '2026-01-01')).toBe(0);
  });
});
