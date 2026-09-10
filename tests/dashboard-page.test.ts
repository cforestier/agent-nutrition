import { describe, it, expect } from 'vitest';

const handler = (await import('../api/dashboard/index.js')).default;

function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
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

describe('GET /api/dashboard', () => {
  it('rejects non-GET requests', () => {
    const res = mockRes();
    handler({ method: 'POST' } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it('serves an HTML page with the Telegram link and a login form', () => {
    const res = mockRes();
    handler({ method: 'GET' } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('https://t.me/Nutrition_malet_bot');
    expect(res.body).toContain('id="login-form"');
    expect(res.body).toContain('/api/dashboard/weights');
  });

  it('includes the macros endpoint call and a chart container per macro', () => {
    const res = mockRes();
    handler({ method: 'GET' } as any, res as any);
    expect(res.body).toContain('/api/dashboard/macros');
    expect(res.body).toContain('id="protein-chart"');
    expect(res.body).toContain('id="carbs-chart"');
    expect(res.body).toContain('id="fat-chart"');
  });

  it('wires up a hover point and tooltip on the chart rendering function', () => {
    const res = mockRes();
    handler({ method: 'GET' } as any, res as any);
    expect(res.body).toContain('hover-dot');
    expect(res.body).toContain('chart-tooltip');
    expect(res.body).toContain("addEventListener('mousemove'");
    expect(res.body).toContain("addEventListener('mouseleave'");
  });
});
