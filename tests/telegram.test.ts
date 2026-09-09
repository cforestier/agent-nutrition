import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseUpdate, sendMessage } from '../lib/telegram.js';

describe('parseUpdate', () => {
  const ALLOWED = 12345;

  it('returns null when there is no message', () => {
    expect(parseUpdate({}, ALLOWED)).toBeNull();
  });

  it('returns null when the message has no text (e.g. a photo)', () => {
    const body = { message: { chat: { id: ALLOWED } } };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });

  it('returns null when the chat id is not the allowed one', () => {
    const body = { message: { chat: { id: 999 }, text: 'hello' } };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });

  it('returns chatId and text for a valid message from the allowed chat', () => {
    const body = { message: { chat: { id: ALLOWED }, text: 'hello' } };
    expect(parseUpdate(body, ALLOWED)).toEqual({ chatId: ALLOWED, text: 'hello' });
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
