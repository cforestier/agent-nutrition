import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';
import { converse } from '../../lib/claude.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);
  const parsed = parseUpdate(req.body, allowedChatId);

  res.status(200).json({ ok: true });

  if (!parsed) return;

  waitUntil(handleMessage(parsed.chatId, parsed.text));
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(10);
  const result = await converse(SYSTEM_PROMPT, [...history, { role: 'user', content: text }]);

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}
