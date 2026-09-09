import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runDailyRecompute } from '../../lib/dailyRecompute.js';
import { addDays } from '../../lib/dateUtils.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end();
    return;
  }

  const todayIso = new Date().toLocaleDateString('en-CA');
  const yesterday = addDays(todayIso, -1);
  const result = await runDailyRecompute(yesterday);

  res.status(200).json(result);
}
