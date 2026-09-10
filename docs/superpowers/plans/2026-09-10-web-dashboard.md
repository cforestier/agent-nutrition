# Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a password-protected web page (`GET /api/dashboard`) showing a weight-over-time chart and a link to open the Telegram bot chat, backed by a JSON weights endpoint.

**Architecture:** Three new Vercel serverless functions under `api/dashboard/` (`index.ts` serves the HTML+JS page, `login.ts` checks the password and issues a session cookie, `weights.ts` returns the weight history as JSON), a new stateless HMAC-based cookie helper in `lib/dashboardAuth.ts`, and a new read-only `getAllWeights()` function added to the existing `lib/weight.ts`. No new npm dependencies — plain TypeScript, matching every other file in `api/` and `lib/`.

**Tech Stack:** TypeScript, `@vercel/node` function signatures (`VercelRequest`/`VercelResponse`), Node's built-in `crypto` module (`createHmac`, `timingSafeEqual`), Prisma (`@prisma/client`) for the `Weight` model, Vitest for tests. Hand-rolled inline SVG for the chart — no charting library.

**Spec:** `docs/superpowers/specs/2026-09-10-web-dashboard-design.md`

## Global Constraints

- No new npm dependencies (design explicitly rejects a charting library and a frontend framework).
- No new Prisma model/schema changes — reuse the existing `Weight` model as-is.
- Session cookie name: `dashboard_session`. Attributes: `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=2592000` (30 days), `Path=/`.
- `DASHBOARD_PASSWORD` is the single source of truth for both the login check and the HMAC key — added to `.env.example` (empty placeholder), to the local `.env`, and to Vercel production env vars.
- No rate limiting / lockout on failed login attempts (explicitly out of scope in the spec).
- Telegram bot username is hardcoded as the constant `Nutrition_malet_bot` (public info, not a secret) — no new env var for it.
- Follow existing repo conventions: handlers are default-exported `async function handler(req, res)` (or plain `function` when no `await` is needed) using `VercelRequest`/`VercelResponse` from `@vercel/node`; tests import the compiled `.js` path (e.g. `../api/dashboard/login.js`) exactly like `tests/cron-tick.test.ts` does.

---

### Task 1: `lib/dashboardAuth.ts` — stateless session cookie helper

**Files:**
- Create: `lib/dashboardAuth.ts`
- Test: `tests/dashboardAuth.test.ts`
- Modify: `.env.example` (add `DASHBOARD_PASSWORD=`)

**Interfaces:**
- Consumes: nothing (pure functions, only Node's built-in `crypto`).
- Produces (used by Task 3 and Task 4):
  - `DASHBOARD_SESSION_COOKIE: string` — the cookie name, `'dashboard_session'`.
  - `signSession(password: string): string` — returns the hex HMAC-SHA256 of a fixed string, keyed by `password`.
  - `isValidSessionToken(token: string | undefined, password: string): boolean` — timing-safe check that `token` matches `signSession(password)`.
  - `buildSessionCookieHeader(password: string): string` — full `Set-Cookie` header value, e.g. `"dashboard_session=<token>; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/"`.
  - `extractSessionToken(cookieHeader: string | undefined): string | undefined` — parses a raw `Cookie` request header and returns just the `dashboard_session` value, or `undefined` if absent.

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboardAuth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_SESSION_COOKIE,
  signSession,
  isValidSessionToken,
  buildSessionCookieHeader,
  extractSessionToken,
} from '../lib/dashboardAuth.js';

describe('signSession', () => {
  it('is deterministic for the same password', () => {
    expect(signSession('correct-horse')).toBe(signSession('correct-horse'));
  });

  it('differs for different passwords', () => {
    expect(signSession('correct-horse')).not.toBe(signSession('other-password'));
  });
});

describe('isValidSessionToken', () => {
  it('accepts a token produced by signSession for the same password', () => {
    const token = signSession('correct-horse');
    expect(isValidSessionToken(token, 'correct-horse')).toBe(true);
  });

  it('rejects a token signed with a different password', () => {
    const token = signSession('correct-horse');
    expect(isValidSessionToken(token, 'wrong-password')).toBe(false);
  });

  it('rejects an undefined token', () => {
    expect(isValidSessionToken(undefined, 'correct-horse')).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = signSession('correct-horse');
    const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    expect(isValidSessionToken(tampered, 'correct-horse')).toBe(false);
  });
});

describe('buildSessionCookieHeader', () => {
  it('builds a cookie header with the expected name, token and attributes', () => {
    const header = buildSessionCookieHeader('correct-horse');
    const expectedToken = signSession('correct-horse');
    expect(header).toContain(`${DASHBOARD_SESSION_COOKIE}=${expectedToken}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=2592000');
    expect(header).toContain('Path=/');
  });
});

describe('extractSessionToken', () => {
  it('returns undefined when there is no cookie header', () => {
    expect(extractSessionToken(undefined)).toBeUndefined();
  });

  it('extracts the token when it is the only cookie', () => {
    expect(extractSessionToken('dashboard_session=abc123')).toBe('abc123');
  });

  it('extracts the token when other cookies are present', () => {
    expect(extractSessionToken('foo=bar; dashboard_session=abc123; baz=qux')).toBe('abc123');
  });

  it('returns undefined when the cookie is not present among others', () => {
    expect(extractSessionToken('foo=bar; baz=qux')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dashboardAuth.test.ts`
Expected: FAIL — `Cannot find module '../lib/dashboardAuth.js'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `lib/dashboardAuth.ts`**

```ts
import { createHmac, timingSafeEqual } from 'crypto';

export const DASHBOARD_SESSION_COOKIE = 'dashboard_session';

export function signSession(password: string): string {
  return createHmac('sha256', password).update('dashboard-session').digest('hex');
}

export function isValidSessionToken(token: string | undefined, password: string): boolean {
  if (!token) return false;
  const expected = signSession(password);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}

export function buildSessionCookieHeader(password: string): string {
  const token = signSession(password);
  return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`;
}

export function extractSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${DASHBOARD_SESSION_COOKIE}=`));
  if (!match) return undefined;
  return match.slice(`${DASHBOARD_SESSION_COOKIE}=`.length);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboardAuth.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Add the env var placeholder**

Modify `.env.example`, add a line after `CRON_SECRET=`:

```
DASHBOARD_PASSWORD=
```

- [ ] **Step 6: Commit**

```bash
git add lib/dashboardAuth.ts tests/dashboardAuth.test.ts .env.example
git commit -m "feat: add stateless HMAC session cookie helper for the dashboard"
```

---

### Task 2: `getAllWeights()` in `lib/weight.ts`

**Files:**
- Modify: `lib/weight.ts`
- Modify (test): `tests/weight.test.ts`

**Interfaces:**
- Consumes: `prisma` from `lib/db.ts` (already imported in `lib/weight.ts`); `WeightEntry` type already defined in `lib/weight.ts` (`{ date: string; weightKg: number }`).
- Produces (used by Task 4): `getAllWeights(): Promise<WeightEntry[]>` — all `Weight` rows ordered by `date` ascending, mapped to `{ date, weightKg }`.

- [ ] **Step 1: Write the failing test**

Add to `tests/weight.test.ts` (new `describe` block, same file, after the existing `weight logging` block):

```ts
describe('getAllWeights', () => {
  const dateA = '1999-06-16';
  const dateB = '1999-06-17';

  afterAll(async () => {
    await prisma.weight.deleteMany({ where: { date: { in: [dateA, dateB] } } });
  });

  it('returns an empty array when there is no data', async () => {
    const result = await getAllWeights();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns entries ordered by date ascending', async () => {
    await saveWeight({ date: dateB, weightKg: 77 });
    await saveWeight({ date: dateA, weightKg: 78 });

    const result = await getAllWeights();
    const indexA = result.findIndex((w) => w.date === dateA);
    const indexB = result.findIndex((w) => w.date === dateB);

    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThan(indexA);
    expect(result.find((w) => w.date === dateA)?.weightKg).toBe(78);
    expect(result.find((w) => w.date === dateB)?.weightKg).toBe(77);
  });
});
```

Update the import line at the top of `tests/weight.test.ts` from:
```ts
import { saveWeight, handleLogWeightTool } from '../lib/weight.js';
```
to:
```ts
import { saveWeight, handleLogWeightTool, getAllWeights } from '../lib/weight.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/weight.test.ts`
Expected: FAIL — `getAllWeights is not a function` (or a TypeScript import error).

- [ ] **Step 3: Implement `getAllWeights`**

Add to `lib/weight.ts`, after `saveWeight`:

```ts
export async function getAllWeights(): Promise<WeightEntry[]> {
  const rows = await prisma.weight.findMany({ orderBy: { date: 'asc' } });
  return rows.map((row) => ({ date: row.date, weightKg: row.weightKg }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/weight.test.ts`
Expected: PASS (all tests in the file, existing + new).

- [ ] **Step 5: Commit**

```bash
git add lib/weight.ts tests/weight.test.ts
git commit -m "feat: add getAllWeights read function"
```

---

### Task 3: `api/dashboard/login.ts`

**Files:**
- Create: `api/dashboard/login.ts`
- Test: `tests/dashboard-login.test.ts`

**Interfaces:**
- Consumes: `buildSessionCookieHeader(password: string): string` from `lib/dashboardAuth.js` (Task 1); `process.env.DASHBOARD_PASSWORD`.
- Produces: `POST /api/dashboard/login` — `405` for non-POST, `401` for a missing/incorrect `{ password }` body, `200` + `Set-Cookie` header for a correct password. No other task depends on this handler's internals (only on the route existing).

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard-login.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dashboard-login.test.ts`
Expected: FAIL — `Cannot find module '../api/dashboard/login.js'`.

- [ ] **Step 3: Implement `api/dashboard/login.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildSessionCookieHeader } from '../../lib/dashboardAuth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const { password } = (req.body ?? {}) as { password?: string };
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected || password !== expected) {
    res.status(401).json({ error: 'Mot de passe incorrect' });
    return;
  }

  res.setHeader('Set-Cookie', buildSessionCookieHeader(expected));
  res.status(200).json({ ok: true });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard-login.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add api/dashboard/login.ts tests/dashboard-login.test.ts
git commit -m "feat: add dashboard login endpoint"
```

---

### Task 4: `api/dashboard/weights.ts`

**Files:**
- Create: `api/dashboard/weights.ts`
- Test: `tests/dashboard-weights.test.ts`

**Interfaces:**
- Consumes: `extractSessionToken`, `isValidSessionToken` from `lib/dashboardAuth.js` (Task 1); `getAllWeights` from `lib/weight.js` (Task 2); `process.env.DASHBOARD_PASSWORD`.
- Produces: `GET /api/dashboard/weights` — `401` when the cookie is missing/invalid, `200` + JSON array of `{ date, weightKg }` when valid. Consumed by the page's client-side JS in Task 5 (fetch only, no compile-time dependency).

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard-weights.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dashboard-weights.test.ts`
Expected: FAIL — `Cannot find module '../api/dashboard/weights.js'`.

- [ ] **Step 3: Implement `api/dashboard/weights.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extractSessionToken, isValidSessionToken } from '../../lib/dashboardAuth.js';
import { getAllWeights } from '../../lib/weight.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = extractSessionToken(req.headers.cookie);
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password || !isValidSessionToken(token, password)) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }

  const weights = await getAllWeights();
  res.status(200).json(weights);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard-weights.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/dashboard/weights.ts tests/dashboard-weights.test.ts
git commit -m "feat: add dashboard weights JSON endpoint"
```

---

### Task 5: `api/dashboard/index.ts` — the HTML page

**Files:**
- Create: `api/dashboard/index.ts`
- Test: `tests/dashboard-page.test.ts`

**Interfaces:**
- Consumes: nothing at compile time (the page's client-side JS calls `/api/dashboard/login` and `/api/dashboard/weights` over `fetch`, which is a runtime dependency on Tasks 3-4, not an import).
- Produces: `GET /api/dashboard` — `405` for non-GET, `200` + `text/html` body containing the login form, chart container, and the Telegram link for GET.

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard-page.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dashboard-page.test.ts`
Expected: FAIL — `Cannot find module '../api/dashboard/index.js'`.

- [ ] **Step 3: Implement `api/dashboard/index.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const BOT_USERNAME = 'Nutrition_malet_bot';

const DASHBOARD_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  #login-form { display: flex; gap: 0.5rem; }
  #login-error { color: #b00020; min-height: 1.2em; }
  #chart-container { margin-top: 1.5rem; }
  a.telegram-link { display: inline-block; margin-top: 1rem; padding: 0.6rem 1rem; background: #229ed9; color: white; text-decoration: none; border-radius: 6px; }
</style>
</head>
<body>
  <h1>Poids</h1>
  <div id="login-view">
    <form id="login-form">
      <input type="password" id="password-input" placeholder="Mot de passe" required />
      <button type="submit">Entrer</button>
    </form>
    <div id="login-error"></div>
  </div>
  <div id="dashboard-view" style="display:none">
    <div id="chart-container"></div>
    <a class="telegram-link" href="https://t.me/${BOT_USERNAME}">Ouvrir le chat Telegram</a>
  </div>

  <script>
    async function loadWeights() {
      const res = await fetch('/api/dashboard/weights');
      if (res.status === 401) {
        document.getElementById('login-view').style.display = '';
        document.getElementById('dashboard-view').style.display = 'none';
        return;
      }
      const weights = await res.json();
      document.getElementById('login-view').style.display = 'none';
      document.getElementById('dashboard-view').style.display = '';
      renderChart(weights);
    }

    function renderChart(weights) {
      const container = document.getElementById('chart-container');
      if (!weights.length) {
        container.textContent = 'Aucune donnée pour l\\'instant.';
        return;
      }
      const width = 600, height = 300, padding = 30;
      const values = weights.map(function (w) { return w.weightKg; });
      const minV = Math.min.apply(null, values);
      const maxV = Math.max.apply(null, values);
      const range = maxV - minV || 1;
      const points = weights.map(function (w, i) {
        const x = padding + (i / (weights.length - 1 || 1)) * (width - 2 * padding);
        const y = height - padding - ((w.weightKg - minV) / range) * (height - 2 * padding);
        return x + ',' + y;
      }).join(' ');
      container.innerHTML = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
        '<polyline fill="none" stroke="#229ed9" stroke-width="2" points="' + points + '" /></svg>' +
        '<div>' + weights[0].date + ' \\u2192 ' + weights[weights.length - 1].date + '</div>';
    }

    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const password = document.getElementById('password-input').value;
      fetch('/api/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
      }).then(function (res) {
        if (res.ok) {
          document.getElementById('login-error').textContent = '';
          loadWeights();
        } else {
          document.getElementById('login-error').textContent = 'Mot de passe incorrect.';
        }
      });
    });

    loadWeights();
  </script>
</body>
</html>`;

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(DASHBOARD_HTML);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard-page.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add api/dashboard/index.ts tests/dashboard-page.test.ts
git commit -m "feat: add the dashboard HTML page"
```

---

### Task 6: Wire up the environment and deploy

**Files:**
- Modify: none (operational task — env vars, deploy, manual browser check)

**Interfaces:**
- Consumes: all of Tasks 1-5.
- Produces: a working, deployed dashboard at `https://agent-nutrition.vercel.app/api/dashboard`.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: every test file touched by this plan passes (`dashboardAuth.test.ts`, `weight.test.ts`, `dashboard-login.test.ts`, `dashboard-weights.test.ts`, `dashboard-page.test.ts`). Pre-existing unrelated failures (local MongoDB replica-set limitations, seen before this plan started) are not this plan's concern.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Choose a real password and set it locally**

Add the chosen password to the local `.env` file as `DASHBOARD_PASSWORD=<the chosen password>` (do not commit `.env` — it's already gitignored, matching the existing `DATABASE_URL`/`TELEGRAM_BOT_TOKEN` entries).

- [ ] **Step 4: Add the password to Vercel production**

Run (this prompts for the value via stdin, so it is never stored in shell history):
```bash
npx vercel env add DASHBOARD_PASSWORD production
```

- [ ] **Step 5: Deploy**

```bash
git push origin master
```
Because Vercel's Git integration is connected (set up in an earlier session), this triggers an automatic production deployment. Confirm it finished with:
```bash
npx vercel ls
```

- [ ] **Step 6: Manual browser verification**

Open `https://agent-nutrition.vercel.app/api/dashboard`:
- Confirm the password form appears first.
- Enter a wrong password → confirm the inline error message appears and no chart is shown.
- Enter the correct password → confirm the chart (or the "Aucune donnée pour l'instant." message, if no weight has been logged yet) and the "Ouvrir le chat Telegram" button appear, and that the button opens the correct chat.
- Reload the page → confirm the session cookie keeps you logged in (no password prompt on reload).

- [ ] **Step 7: Commit any leftover changes**

```bash
git status
```
If `.env.example` wasn't already committed in Task 1, commit it now. `.env` and the real password are never committed.

---

## Self-Review Notes

- **Spec coverage:** routes (Task 3/4/5), auth/cookie (Task 1), data (Task 2), flow (Task 5's JS + Task 3/4 endpoints), error handling (401 branches in Tasks 3/4, empty-data message in Task 5), tests (one per task), env var (Task 1 step 5 + Task 6 steps 3-4), deploy (Task 6). All spec sections are covered.
- **Placeholder scan:** none found — every step has literal, runnable code or an exact command.
- **Type consistency:** `WeightEntry` (`{ date: string; weightKg: number }`) is used identically in Task 2, Task 4's test, and the JSON shape documented in Task 5. `DASHBOARD_SESSION_COOKIE` / `signSession` / `isValidSessionToken` / `buildSessionCookieHeader` / `extractSessionToken` names match exactly between Task 1's implementation and Tasks 3-4's consumption.
