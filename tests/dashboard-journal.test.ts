import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as journalLib from '../lib/journal.js';
import { buildSessionCookieHeader } from '../lib/dashboardAuth.js';

const handler = (await import('../api/dashboard/journal.js')).default;

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

const emptyJournal = { date: '2026-01-01', meals: [], activities: [], weightKg: null, sleepQuality: null };

describe('GET /api/dashboard/journal', () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = 'correct-horse';
  });

  it('rejects a request without a cookie header', async () => {
    const res = mockRes();
    await handler({ headers: {}, query: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with an invalid session cookie', async () => {
    const res = mockRes();
    await handler({ headers: { cookie: 'dashboard_session=bogus' }, query: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('returns the journal for the requested date', async () => {
    const spy = vi.spyOn(journalLib, 'getDailyJournal').mockResolvedValue(emptyJournal);
    const cookieHeader = buildSessionCookieHeader('correct-horse');
    const cookieValue = cookieHeader.split(';')[0];

    const res = mockRes();
    await handler({ headers: { cookie: cookieValue }, query: { date: '2026-01-01' } } as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(emptyJournal);
    expect(spy).toHaveBeenCalledWith('2026-01-01');
  });

  it('falls back to today when the date query param is missing or malformed', async () => {
    const spy = vi.spyOn(journalLib, 'getDailyJournal').mockResolvedValue(emptyJournal);
    const cookieHeader = buildSessionCookieHeader('correct-horse');
    const cookieValue = cookieHeader.split(';')[0];

    const res = mockRes();
    await handler({ headers: { cookie: cookieValue }, query: { date: 'not-a-date' } } as any, res as any);

    expect(res.statusCode).toBe(200);
    const calledWith = spy.mock.calls[0][0];
    expect(calledWith).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
