import { prisma } from './db.js';
import type { WeeklyScheduleEntry, Weekday } from './weeklySchedule.js';

export async function saveWeeklySchedule(entries: WeeklyScheduleEntry[]): Promise<void> {
  await Promise.all(
    entries.map((entry) =>
      prisma.weeklyDefault.upsert({
        where: { weekday: entry.weekday },
        create: { weekday: entry.weekday, activityType: entry.activityType, avgKcal: Math.round(entry.avgKcal) },
        update: { activityType: entry.activityType, avgKcal: Math.round(entry.avgKcal) },
      })
    )
  );
}

export async function hasWeeklySchedule(): Promise<boolean> {
  const count = await prisma.weeklyDefault.count();
  return count > 0;
}

export async function getWeeklyDefault(
  weekday: Weekday
): Promise<{ avgKcal: number; activityType: string } | null> {
  const entry = await prisma.weeklyDefault.findUnique({ where: { weekday } });
  return entry ? { avgKcal: entry.avgKcal, activityType: entry.activityType } : null;
}

export async function weeklyScheduleSystemPromptAddition(): Promise<string> {
  const has = await hasWeeklySchedule();
  if (has) return '';

  return `

L'utilisateur n'a pas encore défini sa semaine type. Propose-lui de la construire avec toi, jour par jour : pour chaque jour où il y a une activité récurrente, demande le type d'activité et sa dépense calorique moyenne, puis appelle set_weekly_schedule (plusieurs jours à la fois si l'utilisateur les donne d'un coup). Ne force rien : s'il préfère faire ça plus tard, n'insiste pas.`;
}
