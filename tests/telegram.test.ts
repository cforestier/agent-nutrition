import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseUpdate,
  sendMessage,
  parseCallbackQuery,
  sendMessageWithKeyboard,
  answerCallbackQuery,
  downloadTelegramFile,
} from '../lib/telegram.js';

describe('parseUpdate', () => {
  const ALLOWED = 12345;

  it('returns null when there is no message', () => {
    expect(parseUpdate({}, ALLOWED)).toBeNull();
  });

  it('returns null when the message has no text and no document (e.g. a sticker)', () => {
    const body = { message: { chat: { id: ALLOWED } } };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });

  it('returns null when the chat id is not the allowed one', () => {
    const body = { message: { chat: { id: 999 }, text: 'hello' } };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });

  it('returns chatId and text for a valid text message from the allowed chat', () => {
    const body = { message: { chat: { id: ALLOWED }, text: 'hello' } };
    expect(parseUpdate(body, ALLOWED)).toEqual({ chatId: ALLOWED, kind: 'text', text: 'hello' });
  });

  it('returns chatId, fileId and mimeType for a document message from the allowed chat', () => {
    const body = {
      message: { chat: { id: ALLOWED }, document: { file_id: 'file123', mime_type: 'application/pdf' } },
    };
    expect(parseUpdate(body, ALLOWED)).toEqual({
      chatId: ALLOWED,
      kind: 'document',
      fileId: 'file123',
      mimeType: 'application/pdf',
    });
  });

  it('returns null for a document message from another chat', () => {
    const body = {
      message: { chat: { id: 999 }, document: { file_id: 'file123', mime_type: 'application/pdf' } },
    };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });
});

describe('downloadTelegramFile', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('resolves the file path via getFile, then downloads and returns the file bytes', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { file_path: 'documents/file_1.pdf' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('pdf-bytes').buffer,
      });

    const result = await downloadTelegramFile('file123');

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.telegram.org/bottest-token/getFile?file_id=file123');
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.telegram.org/file/bottest-token/documents/file_1.pdf');
    expect(result.toString()).toBe('pdf-bytes');
  });

  it('throws when getFile responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad Request' });

    await expect(downloadTelegramFile('file123')).rejects.toThrow('Telegram getFile failed: 400 Bad Request');
  });

  it('throws when the file download responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { file_path: 'documents/file_1.pdf' } }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });

    await expect(downloadTelegramFile('file123')).rejects.toThrow('Telegram file download failed: 404 Not Found');
  });
});

describe('sendMessage', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs to the Telegram API with chat_id and text', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await sendMessage(42, 'echo: hi');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 42, text: 'echo: hi' }),
      }
    );
  });

  it('throws when the Telegram API responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    await expect(sendMessage(42, 'hi')).rejects.toThrow('Telegram sendMessage failed: 400 Bad Request');
  });
});

describe('parseCallbackQuery', () => {
  const ALLOWED = 12345;

  it('returns null when there is no callback_query', () => {
    expect(parseCallbackQuery({}, ALLOWED)).toBeNull();
  });

  it('returns null when the callback has no data', () => {
    const body = { callback_query: { id: 'cq1', message: { chat: { id: ALLOWED } } } };
    expect(parseCallbackQuery(body, ALLOWED)).toBeNull();
  });

  it('returns null when the chat id is not the allowed one', () => {
    const body = { callback_query: { id: 'cq1', data: 'sleep:good', message: { chat: { id: 999 } } } };
    expect(parseCallbackQuery(body, ALLOWED)).toBeNull();
  });

  it('returns the callback query id, chatId and data for a valid callback from the allowed chat', () => {
    const body = { callback_query: { id: 'cq1', data: 'sleep:good', message: { chat: { id: ALLOWED } } } };
    expect(parseCallbackQuery(body, ALLOWED)).toEqual({ callbackQueryId: 'cq1', chatId: ALLOWED, data: 'sleep:good' });
  });
});

describe('sendMessageWithKeyboard', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs to the Telegram API with a single-row inline keyboard', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await sendMessageWithKeyboard(42, 'Nuit ?', [
      { text: 'Bonne', callback_data: 'sleep:good' },
      { text: 'Mauvaise', callback_data: 'sleep:bad' },
    ]);

    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/bottest-token/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: 42,
        text: 'Nuit ?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Bonne', callback_data: 'sleep:good' },
              { text: 'Mauvaise', callback_data: 'sleep:bad' },
            ],
          ],
        },
      }),
    });
  });

  it('throws when the Telegram API responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' });
    await expect(sendMessageWithKeyboard(42, 'Nuit ?', [{ text: 'Bonne', callback_data: 'sleep:good' }])).rejects.toThrow(
      'Telegram sendMessage (with keyboard) failed: 400 Bad Request'
    );
  });
});

describe('answerCallbackQuery', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs the callback_query_id to the Telegram API', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await answerCallbackQuery('cq1');

    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/bottest-token/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: 'cq1' }),
    });
  });

  it('throws when the Telegram API responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' });
    await expect(answerCallbackQuery('cq1')).rejects.toThrow('Telegram answerCallbackQuery failed: 400 Bad Request');
  });
});
