import { describe, it, expect } from 'vitest';
import { addDays, weekdayOf } from '../lib/dateUtils.js';

describe('addDays', () => {
  it('adds positive days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('subtracts days with a negative delta', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('weekdayOf', () => {
  it('returns the correct weekday name for a known date', () => {
    expect(weekdayOf('2026-09-09')).toBe('wednesday');
  });

  it('returns the correct weekday name for another known date', () => {
    expect(weekdayOf('1999-06-14')).toBe('monday');
  });
});
