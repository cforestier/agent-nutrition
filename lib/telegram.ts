export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    document?: { file_id: string; mime_type?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number } };
  };
}

export type ParsedMessage =
  | { chatId: number; kind: 'text'; text: string }
  | { chatId: number; kind: 'document'; fileId: string; mimeType?: string };

export function parseUpdate(body: unknown, allowedChatId: number): ParsedMessage | null {
  const update = body as TelegramUpdate;
  const message = update?.message;
  if (!message) return null;
  if (message.chat.id !== allowedChatId) return null;

  if (typeof message.text === 'string') {
    return { chatId: message.chat.id, kind: 'text', text: message.text };
  }
  if (message.document) {
    return {
      chatId: message.chat.id,
      kind: 'document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
    };
  }
  return null;
}

export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!fileRes.ok) {
    throw new Error(`Telegram getFile failed: ${fileRes.status} ${await fileRes.text()}`);
  }
  const fileJson = (await fileRes.json()) as { result: { file_path: string } };

  const contentRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileJson.result.file_path}`);
  if (!contentRes.ok) {
    throw new Error(`Telegram file download failed: ${contentRes.status} ${await contentRes.text()}`);
  }
  return Buffer.from(await contentRes.arrayBuffer());
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
