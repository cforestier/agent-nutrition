# Étape 4a — Intégration Claude API + webhook conversationnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dumb `echo:` reply in the Telegram webhook with a real Claude-powered response, with conversation history persisted to MongoDB so multi-turn context works across serverless invocations.

**Architecture:** `lib/claude.ts` wraps the Anthropic SDK behind a single `converse()` function (model + max_tokens fixed, refusal handled). `lib/messages.ts` wraps Prisma access to a new `Message` collection (save + fetch-recent). The webhook handler loads recent history, calls `converse()`, persists both the user and assistant turns, and sends the reply — all inside the existing `waitUntil()` background-work pattern from step 1 (see `[[project_agent_nutrition]]` memory note on the Vercel/Fluid Compute gotcha). No tool-use, no onboarding logic, no `/lib/calc` wiring yet — this step only proves the LLM round-trip and history persistence end to end.

**Tech Stack:** `@anthropic-ai/sdk`, model `claude-opus-5` (user's explicit choice — cost is not a reason to substitute a cheaper model here), Vitest with `vi.spyOn` module mocking (no live API calls in tests).

**Spec:** `docs/spec-agent-nutrition-v4.md` §9 (LLM context: profile + notes + daily_state + last 10 messages — this step implements only the "last 10 messages" slice; the rest arrives with onboarding/scenarios), §11 (`messages` table: `datetime, role, content, tokensUsed`), §12 (`/lib/claude.ts`).

## Global Constraints

- Model is `claude-opus-5`, `max_tokens: 1024` — fixed constants in `lib/claude.ts`, not configurable per call (nothing in this step needs per-call overrides).
- `stop_reason: "refusal"` must be handled — return a plain fallback string, never let it propagate as a thrown error or an empty Telegram message.
- No prompt file on disk read at request time — Vercel's Node file-tracing does not reliably bundle files read via a runtime, non-static path, and a missing-file 500 in production is worse than a hardcoded string. The system prompt is a plain exported TS string constant.
- Tests never call the real Anthropic API or a live Telegram/Mongo network path for `lib/claude.ts` and the webhook — mock via `vi.spyOn` on the module's exports, consistent with the existing `tests/webhook.test.ts` pattern for `lib/telegram.ts`. `tests/messages.test.ts` is the one exception (a live Mongo integration test, same style as `tests/db.test.ts`).

---

## File Structure

```
/lib
  claude.ts       # converse(systemPrompt, messages) -> { text, outputTokens }
  prompts.ts       # SYSTEM_PROMPT constant
  messages.ts      # saveMessage(), recentMessages() — Prisma-backed
/api/telegram/webhook.ts   # modified: calls converse() instead of echoing
/prisma/schema.prisma       # add Message model
/tests
  claude.test.ts
  messages.test.ts
  webhook.test.ts           # modified: mocks claude.ts + messages.ts, flushes background tasks
```

---

### Task 1: `lib/claude.ts` — Anthropic SDK wrapper

**Files:**
- Create: `lib/claude.ts`
- Test: `tests/claude.test.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk` dependency)

**Interfaces:**
- Produces:
  - `export interface ChatMessage { role: 'user' | 'assistant'; content: string }`
  - `export interface ConverseResult { text: string; outputTokens: number }`
  - `converse(systemPrompt: string, messages: ChatMessage[]): Promise<ConverseResult>`

- [ ] **Step 1: Add the dependency**

```bash
npm pkg set dependencies."@anthropic-ai/sdk"="^0.68.0"
npm install
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/claude.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { converse } = await import('../lib/claude.js');

describe('converse', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('sends the system prompt and messages to the model and returns text + token count', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Bonjour !' }],
      usage: { output_tokens: 5 },
    });

    const result = await converse('system prompt', [{ role: 'user', content: 'salut' }]);

    expect(result).toEqual({ text: 'Bonjour !', outputTokens: 5 });
    expect(createMock).toHaveBeenCalledWith({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'salut' }],
    });
  });

  it('returns a fallback message when the model refuses', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'refusal',
      content: [],
      usage: { output_tokens: 0 },
    });

    const result = await converse('system prompt', [{ role: 'user', content: 'salut' }]);

    expect(result.text).toBe("Désolé, je ne peux pas répondre à ça.");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — `Cannot find module '../lib/claude.js'`.

- [ ] **Step 4: Create `lib/claude.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 1024;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConverseResult {
  text: string;
  outputTokens: number;
}

export async function converse(systemPrompt: string, messages: ChatMessage[]): Promise<ConverseResult> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { text: 'Désolé, je ne peux pas répondre à ça.', outputTokens: response.usage.output_tokens };
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  return { text, outputTokens: response.usage.output_tokens };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/claude.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/claude.ts tests/claude.test.ts
git commit -m "feat: Anthropic SDK wrapper (converse)"
```

---

### Task 2: `lib/prompts.ts` and `lib/messages.ts` — system prompt + history persistence

**Files:**
- Create: `lib/prompts.ts`
- Create: `lib/messages.ts`
- Test: `tests/messages.test.ts`
- Modify: `prisma/schema.prisma` (add `Message` model)

**Interfaces:**
- Consumes: `ChatMessage` from `lib/claude.ts` (Task 1), `prisma` from `lib/db.ts`.
- Produces:
  - `export const SYSTEM_PROMPT: string`
  - `saveMessage(role: 'user' | 'assistant', content: string, tokensUsed?: number): Promise<void>`
  - `recentMessages(limit?: number): Promise<ChatMessage[]>`

- [ ] **Step 1: Add the `Message` model**

```prisma
// append to prisma/schema.prisma
model Message {
  id         String   @id @default(auto()) @map("_id") @db.ObjectId
  role       String
  content    String
  tokensUsed Int?
  createdAt  DateTime @default(now())
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Create `lib/prompts.ts`**

```ts
export const SYSTEM_PROMPT = `Tu es l'assistant nutrition personnel de Raphaël, un athlète d'endurance en volume élevé (8 à 10h/semaine).
Le profil complet, l'historique structuré et les garde-fous chiffrés ne sont pas encore branchés — l'onboarding n'est pas terminé.
Réponds de façon brève, factuelle, jamais moralisatrice. Ne donne aucun conseil médical.`;
```

- [ ] **Step 4: Write the failing test**

```ts
// tests/messages.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveMessage, recentMessages } from '../lib/messages.js';

describe('messages', () => {
  const marker = `test-${Date.now()}`;

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { content: { contains: marker } } });
  });

  it('saves messages and returns them in chronological order', async () => {
    await saveMessage('user', `${marker}-hello`);
    await saveMessage('assistant', `${marker}-hi there`, 5);

    const recent = await recentMessages(2);

    expect(recent).toEqual([
      { role: 'user', content: `${marker}-hello` },
      { role: 'assistant', content: `${marker}-hi there` },
    ]);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run tests/messages.test.ts`
Expected: FAIL — `Cannot find module '../lib/messages.js'`.

- [ ] **Step 6: Create `lib/messages.ts`**

```ts
import { prisma } from './db.js';
import type { ChatMessage } from './claude.js';

export async function saveMessage(
  role: 'user' | 'assistant',
  content: string,
  tokensUsed?: number
): Promise<void> {
  await prisma.message.create({ data: { role, content, tokensUsed } });
}

export async function recentMessages(limit = 10): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.reverse().map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content }));
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/messages.test.ts`
Expected: PASS (1 test) — this hits the real Atlas cluster, same as `tests/db.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma lib/prompts.ts lib/messages.ts tests/messages.test.ts
git commit -m "feat: message history persistence + system prompt"
```

---

### Task 3: Wire the webhook to Claude

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `converse` from `lib/claude.ts` (Task 1), `SYSTEM_PROMPT` from `lib/prompts.ts`, `saveMessage`/`recentMessages` from `lib/messages.ts` (Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/webhook.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as telegram from '../lib/telegram.js';
import * as claudeLib from '../lib/claude.js';
import * as messagesLib from '../lib/messages.js';

const backgroundTasks: Promise<unknown>[] = [];

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    backgroundTasks.push(promise);
    return promise;
  },
}));

const handler = (await import('../api/telegram/webhook.js')).default;

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

async function flushBackgroundTasks() {
  await Promise.all(backgroundTasks);
  backgroundTasks.length = 0;
}

describe('POST /api/telegram/webhook', () => {
  beforeEach(() => {
    process.env.TELEGRAM_CHAT_ID = '12345';
    backgroundTasks.length = 0;
  });

  it('rejects non-POST requests', async () => {
    const res = mockRes();
    await handler({ method: 'GET', body: {} } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it("responds 200 and replies with Claude's answer from the allowed chat", async () => {
    vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
    vi.spyOn(claudeLib, 'converse').mockResolvedValue({ text: 'Bonjour !', outputTokens: 5 });
    const saveSpy = vi.spyOn(messagesLib, 'saveMessage').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = { message: { chat: { id: 12345 }, text: 'salut' } };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(claudeLib.converse).toHaveBeenCalledWith(expect.any(String), [{ role: 'user', content: 'salut' }]);
    expect(saveSpy).toHaveBeenCalledWith('user', 'salut');
    expect(saveSpy).toHaveBeenCalledWith('assistant', 'Bonjour !', 5);
    expect(sendSpy).toHaveBeenCalledWith(12345, 'Bonjour !');
  });

  it('responds 200 but does nothing for a message from another chat', async () => {
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const converseSpy = vi.spyOn(claudeLib, 'converse');
    const res = mockRes();
    const body = { message: { chat: { id: 999 }, text: 'salut' } };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(converseSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the handler still echoes and never calls `converse`/`saveMessage`.

- [ ] **Step 3: Update `api/telegram/webhook.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';
import { converse } from '../../lib/claude.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);
  const parsed = parseUpdate(req.body, allowedChatId);

  res.status(200).json({ ok: true });

  if (!parsed) return;

  waitUntil(handleMessage(parsed.chatId, parsed.text));
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(10);
  const result = await converse(SYSTEM_PROMPT, [...history, { role: 'user', content: text }]);

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: webhook replies via Claude instead of echoing"
```

- [ ] **Step 7: Set `ANTHROPIC_API_KEY` and deploy (manual)**

Add `ANTHROPIC_API_KEY` to `.env` (git-ignored) and `.env.example` (empty placeholder), push it to Vercel production (`vercel env add ANTHROPIC_API_KEY production`), then `vercel deploy --prod`. Send a real message to the bot and confirm the reply is a genuine Claude response, not `echo: ...`.

---

## Self-Review

**Spec coverage:** §12 `/lib/claude.ts` ✅ (Task 1). §11 `messages` table (`datetime, role, content, tokensUsed`) ✅ (Task 2 — `createdAt` maps to `datetime`). §9 "10 derniers messages" context slice ✅ (Task 3's `recentMessages(10)`); the rest of §9's context (profile, notes, dailyState, performance) doesn't exist yet and is correctly deferred — this step doesn't claim to build it.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `ChatMessage` (Task 1) is the exact shape `recentMessages` returns (Task 2) and the exact shape the webhook spreads into `converse()`'s second argument (Task 3). `ConverseResult { text, outputTokens }` (Task 1) matches its two consumers in Task 3 (`saveMessage('assistant', result.text, result.outputTokens)` and `sendMessage(chatId, result.text)`).
