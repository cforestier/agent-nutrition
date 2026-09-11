import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as todaySummaryLib from '../lib/todaySummary.js';
import { buildSessionCookieHeader } from '../lib/dashboardAuth.js';

const handler = (await import('../api/dashboard/today.js')).default;

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

describe('GET /api/dashboard/today', () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = 'correct-horse';
  });

  it('rejects a request without a cookie header', async () => {
    const res = mockRes();
    await handler({ headers: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with an invalid session cookie', async () => {
    const res = mockRes();
    await handler({ headers: { cookie: 'dashboard_session=bogus' } } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it("returns today's summary for a valid session cookie", async () => {
    const summary = {
      date: '2026-01-01',
      totalKcal: 1200,
      proteinG: 90,
      carbsG: 120,
      fatG: 40,
      targetKcal: 2500,
      proteinTargetMinG: 150,
      proteinTargetMaxG: 165,
      fatTargetG: 69,
      carbsTargetG: 320,
    };
    const getTodaySpy = vi.spyOn(todaySummaryLib, 'getTodaySummary').mockResolvedValue(summary);
    const cookieHeader = buildSessionCookieHeader('correct-horse');
    const cookieValue = cookieHeader.split(';')[0];

    const res = mockRes();
    await handler({ headers: { cookie: cookieValue } } as any, res as any);

    expect(getTodaySpy).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(summary);
  });
});
