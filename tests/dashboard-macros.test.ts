import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as notificationStoreLib from '../lib/notificationStore.js';
import { buildSessionCookieHeader } from '../lib/dashboardAuth.js';

const handler = (await import('../api/dashboard/macros.js')).default;

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

describe('GET /api/dashboard/macros', () => {
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

  it('returns the last 30 days of macro history for a valid session cookie', async () => {
    const getRecentSpy = vi
      .spyOn(notificationStoreLib, 'getRecentDailyStates')
      .mockResolvedValue([{ date: '2026-01-01', totalKcal: 2600, proteinG: 140, carbsG: 260, fatG: 70 }]);
    const cookieHeader = buildSessionCookieHeader('correct-horse');
    const cookieValue = cookieHeader.split(';')[0];

    const res = mockRes();
    await handler({ headers: { cookie: cookieValue } } as any, res as any);

    expect(getRecentSpy).toHaveBeenCalledWith(30);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([{ date: '2026-01-01', totalKcal: 2600, proteinG: 140, carbsG: 260, fatG: 70 }]);
  });
});
