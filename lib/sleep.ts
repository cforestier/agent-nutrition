import { prisma } from './db.js';
import type { SleepQuality } from './calc/baseline.js';

export async function saveSleepQuality(date: string, quality: SleepQuality): Promise<void> {
  await prisma.sleepLog.upsert({
    where: { date },
    create: { date, quality },
    update: { quality },
  });
}

export async function recentSleepQualities(limit = 2): Promise<SleepQuality[]> {
  const logs = await prisma.sleepLog.findMany({ orderBy: { date: 'desc' }, take: limit });
  return logs.map((log) => log.quality as SleepQuality).reverse();
}
