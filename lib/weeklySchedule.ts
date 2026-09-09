import { saveWeeklySchedule } from './weeklyScheduleStore.js';
import type { ToolDefinition } from './claude.js';

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface WeeklyScheduleEntry {
  weekday: Weekday;
  activityType: string;
  avgKcal: number;
}

export const SET_WEEKLY_SCHEDULE_TOOL: ToolDefinition = {
  name: 'set_weekly_schedule',
  description:
    "Enregistre ou met à jour un ou plusieurs jours de la semaine type de l'utilisateur : jour, type d'activité, dépense calorique moyenne pour cette activité. Peut être appelé plusieurs fois pour compléter ou corriger la semaine au fil de la conversation.",
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            weekday: { type: 'string', enum: [...WEEKDAYS] },
            activityType: { type: 'string' },
            avgKcal: { type: 'number' },
          },
          required: ['weekday', 'activityType', 'avgKcal'],
        },
      },
    },
    required: ['entries'],
  },
};

export async function handleWeeklyScheduleTool(rawInput: Record<string, unknown>): Promise<string> {
  const { entries } = rawInput as unknown as { entries: WeeklyScheduleEntry[] };
  await saveWeeklySchedule(entries);
  const summary = entries.map((e) => `${e.weekday}: ${e.activityType} (~${e.avgKcal} kcal)`).join(', ');
  return `Semaine type mise à jour : ${summary}.`;
}
