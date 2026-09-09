import type { Weekday } from './weeklySchedule.js';

const WEEKDAY_ORDER: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function addDays(dateStr: string, delta: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr: string): Weekday {
  const dayIndex = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return WEEKDAY_ORDER[dayIndex];
}
