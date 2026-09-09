export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

export interface ParsedMessage {
  chatId: number;
  text: string;
}

export function parseUpdate(body: unknown, allowedChatId: number): ParsedMessage | null {
  const update = body as TelegramUpdate;
  const message = update?.message;
  if (!message || typeof message.text !== 'string') return null;
  if (message.chat.id !== allowedChatId) return null;
  return { chatId: message.chat.id, text: message.text };
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}
