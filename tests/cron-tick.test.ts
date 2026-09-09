import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as notificationTickLib from '../lib/notificationTick.js';

const handler = (await import('../api/cron/tick.js')).default;

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

describe('GET /api/cron/tick', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    process.env.TELEGRAM_CHAT_ID = '12345';
  });

  it('rejects requests without the correct bearer token', async () => {
    const res = mockRes();
    await handler({ headers: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('runs the tick and returns the result when authorized', async () => {
    const spy = vi
      .spyOn(notificationTickLib, 'runNotificationTick')
      .mockResolvedValue({ sent: [], skippedQuietHours: false });

    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer test-secret' } } as any, res as any);

    expect(spy).toHaveBeenCalledWith(expect.any(Date), 12345);
    expect(res.statusCode).toBe(200);
  });
});
