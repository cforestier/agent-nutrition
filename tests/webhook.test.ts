import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as telegram from '../lib/telegram.js';
import handler from '../api/telegram/webhook.js';

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

describe('POST /api/telegram/webhook', () => {
  beforeEach(() => {
    process.env.TELEGRAM_CHAT_ID = '12345';
  });

  it('rejects non-POST requests', async () => {
    const res = mockRes();
    await handler({ method: 'GET', body: {} } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it('responds 200 and echoes back text from the allowed chat', async () => {
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = { message: { chat: { id: 12345 }, text: 'hello' } };

    await handler({ method: 'POST', body } as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(12345, 'echo: hello');
  });

  it('responds 200 but sends nothing for a message from another chat', async () => {
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = { message: { chat: { id: 999 }, text: 'hello' } };

    await handler({ method: 'POST', body } as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
