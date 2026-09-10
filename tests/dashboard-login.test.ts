import { describe, it, expect, beforeEach } from 'vitest';

const handler = (await import('../api/dashboard/login.js')).default;

function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

describe('POST /api/dashboard/login', () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = 'correct-horse';
  });

  it('rejects non-POST requests', async () => {
    const res = mockRes();
    await handler({ method: 'GET', body: {} } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a missing password', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('rejects an incorrect password', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { password: 'wrong' } } as any, res as any);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('accepts the correct password and sets the session cookie', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { password: 'correct-horse' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Set-Cookie']).toContain('dashboard_session=');
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
  });
});
