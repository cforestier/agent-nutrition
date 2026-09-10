import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as weightLib from '../lib/weight.js';
import { buildSessionCookieHeader } from '../lib/dashboardAuth.js';

const handler = (await import('../api/dashboard/weights.js')).default;

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

describe('GET /api/dashboard/weights', () => {
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

  it('returns the weight history for a valid session cookie', async () => {
    vi.spyOn(weightLib, 'getAllWeights').mockResolvedValue([{ date: '2026-01-01', weightKg: 80 }]);
    const cookieHeader = buildSessionCookieHeader('correct-horse');
    const cookieValue = cookieHeader.split(';')[0];

    const res = mockRes();
    await handler({ headers: { cookie: cookieValue } } as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([{ date: '2026-01-01', weightKg: 80 }]);
  });
});
