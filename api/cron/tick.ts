import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runNotificationTick } from '../../lib/notificationTick.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end();
    return;
  }

  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  const result = await runNotificationTick(new Date(), chatId);

  res.status(200).json(result);
}
