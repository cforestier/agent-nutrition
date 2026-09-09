# Étape 1 — Setup, connexion DB, webhook Telegram écho — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the agent-nutrition project, connect it to MongoDB Atlas via Prisma, and deploy a Telegram webhook that echoes back any text message sent by the authorized user.

**Architecture:** A single Vercel serverless function (`api/telegram/webhook.ts`) receives Telegram updates via POST. It delegates parsing/filtering and Telegram API calls to `lib/telegram.ts` (pure, unit-testable functions), and responds `200 OK` immediately before finishing async work, per the project's serverless constraints. `lib/db.ts` exposes a cached Prisma client (MongoDB provider) so later steps can read/write data; this step only proves connectivity.

**Tech Stack:** Node.js (TypeScript, ESM), Prisma (`mongodb` provider) against MongoDB Atlas M0, Telegram Bot API via raw `fetch` (no SDK), Vercel serverless functions (Node runtime), Vitest for tests.

**Spec:** `docs/spec-agent-nutrition-v4.md` (functional spec — this plan implements only §14 build-order step 1: "Setup, Postgres + migrations, webhook Telegram, écho simple", adapted to MongoDB/Prisma per the stack pivot agreed in conversation — no SQL migrations exist for Mongo, connectivity is proven instead).

## Global Constraints

- Runtime: Node.js, TypeScript, ESM (`"type": "module"` in package.json).
- Serverless only: no long-running process, no in-memory state relied on across invocations except the cached Prisma client (standard Vercel pattern).
- Webhook must respond within Telegram's timeout: send the HTTP response first, then continue async work in the same invocation.
- Only the user's own `TELEGRAM_CHAT_ID` may trigger a response — all other chat IDs are silently ignored (no multi-user support, no auth beyond this).
- No secrets committed: `.env` is git-ignored from the first commit.

---

## File Structure

```
/api
  /telegram/webhook.ts    # Vercel function: thin wiring only
/lib
  /db.ts                  # cached PrismaClient singleton
  /telegram.ts            # parseUpdate() + sendMessage(), pure/testable
/prisma
  /schema.prisma          # MongoDB datasource + minimal Profile model
/tests
  /db.test.ts
  /telegram.test.ts
  /webhook.test.ts
package.json
tsconfig.json
vitest.config.ts
.env.example
.gitignore
README.md
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Produces: an installable, typed, testable empty project. No exported functions yet.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agent-nutrition",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "postinstall": "prisma generate"
  },
  "dependencies": {
    "@prisma/client": "^5.20.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@vercel/node": "^3.2.0",
    "prisma": "^5.20.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["api", "lib", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['dotenv/config'],
  },
});
```

Add `dotenv` so the config above resolves:

```bash
npm pkg set devDependencies.dotenv="^16.4.0"
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
.env
.env.local
.vercel
dist
```

- [ ] **Step 5: Create `.env.example`**

```
DATABASE_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

- [ ] **Step 6: Create `README.md`**

```markdown
# agent-nutrition

Personal, single-user nutrition/training tracker driven by a Telegram bot.
Full functional spec: `docs/spec-agent-nutrition-v4.md`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — MongoDB Atlas connection string (Prisma-compatible, `mongodb+srv://...`)
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_CHAT_ID` — your own Telegram numeric chat id (only this id gets responses)
3. `npm test` — runs unit tests, including a live check that Prisma can reach MongoDB.

## Deploying the webhook (step 1)

1. `vercel link` (creates/links the Vercel project) then `vercel env add` for each variable above, or set them in the Vercel dashboard → Settings → Environment Variables.
2. `vercel deploy --prod`
3. Register the webhook with Telegram (replace values):
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-vercel-domain>/api/telegram/webhook"
   ```
4. Send any text message to the bot from your own Telegram account — you should get `echo: <your message>` back. Messages from any other chat id are silently ignored.
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: installs cleanly, `node_modules/.prisma` and `node_modules/@prisma/client` present (postinstall ran `prisma generate` — this will fail until `prisma/schema.prisma` exists, so ignore a postinstall error at this step only; it will pass again after Task 2).

- [ ] **Step 8: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example README.md
git commit -m "chore: project scaffold"
```

---

### Task 2: Prisma + MongoDB connectivity

**Files:**
- Create: `prisma/schema.prisma`
- Create: `lib/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` env var (Task 1's `.env.example` documents it; a real `.env` must be created locally with the actual Atlas connection string — not committed).
- Produces: `export const prisma: PrismaClient` from `lib/db.ts`, used by later steps to read/write any collection.

- [ ] **Step 1: Create `prisma/schema.prisma`**

```prisma
datasource db {
  provider = "mongodb"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Profile {
  id                 String   @id @default(auto()) @map("_id") @db.ObjectId
  onboardingComplete Boolean  @default(false)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

- [ ] **Step 2: Generate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Write the failing test**

```ts
// tests/db.test.ts
import { describe, it, expect } from 'vitest';
import { prisma } from '../lib/db.js';

describe('MongoDB connectivity', () => {
  it('can query the Profile collection through Prisma', async () => {
    const count = await prisma.profile.count();
    expect(typeof count).toBe('number');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `lib/db.ts` does not exist yet (`Cannot find module '../lib/db.js'`).

- [ ] **Step 5: Create `lib/db.ts`**

```ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 6: Fill in your real `.env`**

Create `.env` (git-ignored, not committed) with the actual Atlas connection string as `DATABASE_URL`, plus placeholder values for the Telegram vars (filled for real in Task 3):

```
DATABASE_URL="mongodb+srv://maletraphaelironhack_db_user:<password>@clusternutritionagent.21mob6k.mongodb.net/agent_nutrition?retryWrites=true&w=majority&appName=ClusterNutritionAgent"
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Note the added `/agent_nutrition` path segment before the `?` — this names the database Mongo will create on first write; without it Prisma defaults to a database named `test`.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS — `count` is `0` on the first run (empty, auto-vivified collection).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma lib/db.ts tests/db.test.ts
git commit -m "feat: connect to MongoDB via Prisma"
```

---

### Task 3: Telegram parsing and sending (pure functions)

**Files:**
- Create: `lib/telegram.ts`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: `TELEGRAM_BOT_TOKEN` env var (used inside `sendMessage`).
- Produces:
  - `parseUpdate(body: unknown, allowedChatId: number): { chatId: number; text: string } | null`
  - `sendMessage(chatId: number, text: string): Promise<void>`
  - `export interface TelegramUpdate { message?: { chat: { id: number }; text?: string } }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/telegram.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseUpdate, sendMessage } from '../lib/telegram.js';

describe('parseUpdate', () => {
  const ALLOWED = 12345;

  it('returns null when there is no message', () => {
    expect(parseUpdate({}, ALLOWED)).toBeNull();
  });

  it('returns null when the message has no text (e.g. a photo)', () => {
    const body = { message: { chat: { id: ALLOWED } } };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });

  it('returns null when the chat id is not the allowed one', () => {
    const body = { message: { chat: { id: 999 }, text: 'hello' } };
    expect(parseUpdate(body, ALLOWED)).toBeNull();
  });

  it('returns chatId and text for a valid message from the allowed chat', () => {
    const body = { message: { chat: { id: ALLOWED }, text: 'hello' } };
    expect(parseUpdate(body, ALLOWED)).toEqual({ chatId: ALLOWED, text: 'hello' });
  });
});

describe('sendMessage', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs to the Telegram API with chat_id and text', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await sendMessage(42, 'echo: hi');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 42, text: 'echo: hi' }),
      }
    );
  });

  it('throws when the Telegram API responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    await expect(sendMessage(42, 'hi')).rejects.toThrow('Telegram sendMessage failed: 400 Bad Request');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/telegram.test.ts`
Expected: FAIL — `Cannot find module '../lib/telegram.js'`.

- [ ] **Step 3: Create `lib/telegram.ts`**

```ts
export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

export interface ParsedMessage {
  chatId: number;
  text: string;
}

export function parseUpdate(body: unknown, allowedChatId: number): ParsedMessage | null {
  const update = body as TelegramUpdate;
  const message = update?.message;
  if (!message || typeof message.text !== 'string') return null;
  if (message.chat.id !== allowedChatId) return null;
  return { chatId: message.chat.id, text: message.text };
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/telegram.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/telegram.ts tests/telegram.test.ts
git commit -m "feat: parse Telegram updates and send messages"
```

---

### Task 4: Webhook route and end-to-end wiring

**Files:**
- Create: `api/telegram/webhook.ts`
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `parseUpdate`, `sendMessage` from `lib/telegram.ts` (Task 3); `TELEGRAM_CHAT_ID` env var.
- Produces: the deployed HTTP endpoint `POST /api/telegram/webhook`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webhook.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — `Cannot find module '../api/telegram/webhook.js'`.

- [ ] **Step 3: Create `api/telegram/webhook.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  res.status(200).json({ ok: true });

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);
  const parsed = parseUpdate(req.body, allowedChatId);
  if (!parsed) return;

  await sendMessage(parsed.chatId, `echo: ${parsed.text}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests across `tests/db.test.ts`, `tests/telegram.test.ts`, `tests/webhook.test.ts` PASS.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: Telegram webhook echo endpoint"
```

- [ ] **Step 8: Deploy and register the webhook (manual, not automated)**

Follow the "Deploying the webhook" section of `README.md` (Task 1, Step 6): `vercel link`, set the three env vars in the Vercel dashboard, `vercel deploy --prod`, then call Telegram's `setWebhook` with the deployed URL. Send a real message from your own Telegram account to confirm you get `echo: <message>` back.

---

## Self-Review

**Spec coverage (v4 §14 step 1 — "Setup, [DB] + migrations, webhook Telegram, écho simple"):** scaffold ✅ (Task 1), DB connectivity in place of SQL migrations since Mongo is schemaless ✅ (Task 2), webhook + echo ✅ (Tasks 3–4). Chat-id filtering from v0 §2 ("seul filtre d'accès est mon chat_id Telegram") is carried forward even though v4 doesn't restate it ✅ (Task 3/4). The `<10s` response constraint from v4 §1 is implemented via responding before awaiting `sendMessage` ✅ (Task 4).

**Placeholder scan:** none found — every step has runnable code and concrete expected output.

**Type consistency:** `ParsedMessage { chatId: number; text: string }` (Task 3) is the exact shape asserted in Task 4's tests and consumed by `webhook.ts`. `sendMessage(chatId: number, text: string)` signature matches its Task 3 definition and its Task 4 call site. No mismatches.
