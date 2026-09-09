export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number } };
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

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export async function sendMessageWithKeyboard(
  chatId: number,
  text: string,
  buttons: InlineKeyboardButton[]
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: [buttons] },
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage (with keyboard) failed: ${res.status} ${await res.text()}`);
  }
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
  if (!res.ok) {
    throw new Error(`Telegram answerCallbackQuery failed: ${res.status} ${await res.text()}`);
  }
}

export interface ParsedCallbackQuery {
  callbackQueryId: string;
  chatId: number;
  data: string;
}

export function parseCallbackQuery(body: unknown, allowedChatId: number): ParsedCallbackQuery | null {
  const update = body as TelegramUpdate;
  const callbackQuery = update?.callback_query;
  if (!callbackQuery || typeof callbackQuery.data !== 'string' || !callbackQuery.message) return null;
  if (callbackQuery.message.chat.id !== allowedChatId) return null;
  return { callbackQueryId: callbackQuery.id, chatId: callbackQuery.message.chat.id, data: callbackQuery.data };
}
