import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  res.status(200).json({ ok: true });

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);
  const parsed = parseUpdate(req.body, allowedChatId);
  if (!parsed) return;

  await sendMessage(parsed.chatId, `echo: ${parsed.text}`);
}
