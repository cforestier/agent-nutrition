import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dailyRecomputeLib from '../lib/dailyRecompute.js';

const handler = (await import('../api/cron/daily-recompute.js')).default;

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

describe('GET /api/cron/daily-recompute', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
  });

  it('rejects requests without the correct bearer token', async () => {
    const res = mockRes();
    await handler({ headers: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('runs the recompute for yesterday and returns the result when authorized', async () => {
    const spy = vi
      .spyOn(dailyRecomputeLib, 'runDailyRecompute')
      .mockResolvedValue({ date: '2026-01-01' } as any);

    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer test-secret' } } as any, res as any);

    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});
