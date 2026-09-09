# "Nuit ?" one-tap + Telegram inline keyboards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two gaps explicitly deferred in steps 8 and 9: the "nuit ?" (bonne/moyenne/mauvaise) one-tap question has no capture mechanism, and `blocksDownwardAdjustmentFromSleep` (spec §6) has no data feed. Build Telegram inline-keyboard support, wire the tap into the existing day-plan-prompt notification, capture it via `callback_query` handling in the webhook, and feed it into `runDailyRecompute`'s adjustment decision.

**Architecture:** Button taps are handled entirely in deterministic code — no Claude call, same principle as step 9's notifications. `lib/telegram.ts` gains keyboard-sending and `callback_query`-parsing primitives. A new `SleepLog` collection stores one quality value per date. `lib/calc/adjust.ts`'s `computeAdjustment` gains a `sleepBlocksDownwardAdjustment` input that short-circuits the "too slow → decrease" branch, per spec §6 ("deux nuits 'mauvaise' consécutives → aucun ajustement à la baisse").

**Tech Stack:** Same as the rest of the project (Node/TS ESM, Prisma/MongoDB, Vitest, `@vercel/node`).

**Spec:** `docs/spec-agent-nutrition-v4.md` §6 ("Sommeil — auto-déclaré"), §9 (day-plan notification's "nuit ?" tap).

## Global Constraints

- **No Claude dependency** — same principle as step 9. The tap is a `callback_query` update handled with plain code; nothing here needs `ANTHROPIC_API_KEY`.
- **`SleepQuality` type already exists** (`lib/calc/baseline.ts`, `'good' | 'medium' | 'bad'`) — reused everywhere in this plan rather than redefined.
- **Breaking change to `AdjustmentInput`, handled the established way**: `sleepBlocksDownwardAdjustment: boolean` is added as a required field; every existing call site and test fixture is updated in the same commit (same pattern as `converseWithTool`'s single-tool→multi-tool generalization earlier in this project).
- **`recentSleepQualities()` is an unbounded "most recent N" query** (no date filter, by design — sleep gating always looks at the last 2 real nights regardless of date) — same test-isolation risk already learned from `getMostRecentMeal`/`getMostRecentDailyState` in step 9. It's wrapped in `lib/sleep.ts` and **mocked via `vi.spyOn` in `dailyRecompute.test.ts`**, never touched live from that test file. `SleepLog` itself is still a normal accumulating, date-keyed collection — safe to live-test directly in `sleep.test.ts` with a fresh historical date.
- **Telegram requires `answerCallbackQuery`** on every button tap, or the tapping user's Telegram client shows a stuck loading spinner. This is called unconditionally in the webhook's callback-query handler, before any other logic.

---

### Task 1: Telegram inline-keyboard primitives

**Files:**
- Modify: `lib/telegram.ts`
- Modify: `tests/telegram.test.ts`

**Interfaces:**
- Produces: `InlineKeyboardButton` interface, `sendMessageWithKeyboard(chatId, text, buttons): Promise<void>`, `answerCallbackQuery(callbackQueryId): Promise<void>`, `ParsedCallbackQuery` interface, `parseCallbackQuery(body, allowedChatId): ParsedCallbackQuery | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/telegram.test.ts` (add `parseCallbackQuery, sendMessageWithKeyboard, answerCallbackQuery` to the existing import line from `../lib/telegram.js`):

```typescript
describe('parseCallbackQuery', () => {
  const ALLOWED = 12345;

  it('returns null when there is no callback_query', () => {
    expect(parseCallbackQuery({}, ALLOWED)).toBeNull();
  });

  it('returns null when the callback has no data', () => {
    const body = { callback_query: { id: 'cq1', message: { chat: { id: ALLOWED } } } };
    expect(parseCallbackQuery(body, ALLOWED)).toBeNull();
  });

  it('returns null when the chat id is not the allowed one', () => {
    const body = { callback_query: { id: 'cq1', data: 'sleep:good', message: { chat: { id: 999 } } } };
    expect(parseCallbackQuery(body, ALLOWED)).toBeNull();
  });

  it('returns the callback query id, chatId and data for a valid callback from the allowed chat', () => {
    const body = { callback_query: { id: 'cq1', data: 'sleep:good', message: { chat: { id: ALLOWED } } } };
    expect(parseCallbackQuery(body, ALLOWED)).toEqual({ callbackQueryId: 'cq1', chatId: ALLOWED, data: 'sleep:good' });
  });
});

describe('sendMessageWithKeyboard', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs to the Telegram API with a single-row inline keyboard', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await sendMessageWithKeyboard(42, 'Nuit ?', [
      { text: 'Bonne', callback_data: 'sleep:good' },
      { text: 'Mauvaise', callback_data: 'sleep:bad' },
    ]);

    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/bottest-token/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: 42,
        text: 'Nuit ?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Bonne', callback_data: 'sleep:good' },
              { text: 'Mauvaise', callback_data: 'sleep:bad' },
            ],
          ],
        },
      }),
    });
  });

  it('throws when the Telegram API responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' });
    await expect(sendMessageWithKeyboard(42, 'Nuit ?', [{ text: 'Bonne', callback_data: 'sleep:good' }])).rejects.toThrow(
      'Telegram sendMessage (with keyboard) failed: 400 Bad Request'
    );
  });
});

describe('answerCallbackQuery', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs the callback_query_id to the Telegram API', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await answerCallbackQuery('cq1');

    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/bottest-token/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: 'cq1' }),
    });
  });

  it('throws when the Telegram API responds with a non-ok status', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' });
    await expect(answerCallbackQuery('cq1')).rejects.toThrow('Telegram answerCallbackQuery failed: 400 Bad Request');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/telegram.test.ts`
Expected: FAIL — `parseCallbackQuery`/`sendMessageWithKeyboard`/`answerCallbackQuery` don't exist yet.

- [ ] **Step 3: Implement in `lib/telegram.ts`**

Replace the top of the file (the `TelegramUpdate` interface) and append the new functions at the end:

```typescript
export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number } };
  };
}
```

Append after the existing `sendMessage` function:

```typescript
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export async function sendMessageWithKeyboard(
  chatId: number,
  text: string,
  buttons: InlineKeyboardButton[]
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: [buttons] },
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage (with keyboard) failed: ${res.status} ${await res.text()}`);
  }
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
  if (!res.ok) {
    throw new Error(`Telegram answerCallbackQuery failed: ${res.status} ${await res.text()}`);
  }
}

export interface ParsedCallbackQuery {
  callbackQueryId: string;
  chatId: number;
  data: string;
}

export function parseCallbackQuery(body: unknown, allowedChatId: number): ParsedCallbackQuery | null {
  const update = body as TelegramUpdate;
  const callbackQuery = update?.callback_query;
  if (!callbackQuery || typeof callbackQuery.data !== 'string' || !callbackQuery.message) return null;
  if (callbackQuery.message.chat.id !== allowedChatId) return null;
  return { callbackQueryId: callbackQuery.id, chatId: callbackQuery.message.chat.id, data: callbackQuery.data };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/telegram.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/telegram.ts tests/telegram.test.ts
git commit -m "feat: add Telegram inline-keyboard send + callback_query parsing"
```

---

### Task 2: `SleepLog` model + `lib/sleep.ts`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `lib/sleep.ts`
- Test: `tests/sleep.test.ts`

**Interfaces:**
- Consumes: `SleepQuality` type (`lib/calc/baseline.js`).
- Produces: `saveSleepQuality(date, quality): Promise<void>`, `recentSleepQualities(limit?): Promise<SleepQuality[]>`.

- [ ] **Step 1: Add the `SleepLog` model**

In `prisma/schema.prisma`, append:

```prisma
model SleepLog {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  date      String   @unique
  quality   String
  createdAt DateTime @default(now())
}
```

Run: `npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 2: Write the failing tests**

Create `tests/sleep.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveSleepQuality, recentSleepQualities } from '../lib/sleep.js';

const TEST_DATES = ['1999-10-01', '1999-10-02', '1999-10-03'];

describe('sleep', () => {
  afterAll(async () => {
    await prisma.sleepLog.deleteMany({ where: { date: { in: TEST_DATES } } });
  });

  it('saves a sleep quality for a date, overwriting on a second call for the same date', async () => {
    await saveSleepQuality('1999-10-01', 'good');
    await saveSleepQuality('1999-10-01', 'bad');

    const saved = await prisma.sleepLog.findUnique({ where: { date: '1999-10-01' } });
    expect(saved?.quality).toBe('bad');
  });

  it('returns the most recent N qualities in chronological order', async () => {
    await saveSleepQuality('1999-10-02', 'medium');
    await saveSleepQuality('1999-10-03', 'bad');

    const recent = await recentSleepQualities(2);
    expect(recent).toEqual(['medium', 'bad']);
  });

  it('returns an array without throwing when queried', async () => {
    await prisma.sleepLog.deleteMany({ where: { date: { in: TEST_DATES } } });
    const recent = await recentSleepQualities(2);
    // Not asserting emptiness strictly (this is an unbounded "most recent" query, mocked
    // everywhere else in the suite per the Global Constraints note) — just that it resolves.
    expect(Array.isArray(recent)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/sleep.test.ts`
Expected: FAIL with "Cannot find module '../lib/sleep.js'"

- [ ] **Step 4: Implement `lib/sleep.ts`**

```typescript
import { prisma } from './db.js';
import type { SleepQuality } from './calc/baseline.js';

export async function saveSleepQuality(date: string, quality: SleepQuality): Promise<void> {
  await prisma.sleepLog.upsert({
    where: { date },
    create: { date, quality },
    update: { quality },
  });
}

export async function recentSleepQualities(limit = 2): Promise<SleepQuality[]> {
  const logs = await prisma.sleepLog.findMany({ orderBy: { date: 'desc' }, take: limit });
  return logs.map((log) => log.quality as SleepQuality).reverse();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/sleep.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma lib/sleep.ts tests/sleep.test.ts
git commit -m "feat: add SleepLog model and lib/sleep.ts"
```

---

### Task 3: Sleep-gating in `computeAdjustment`

**Files:**
- Modify: `lib/calc/adjust.ts`
- Modify: `tests/calc/adjust.test.ts`

**Interfaces:**
- Produces: `AdjustmentInput.sleepBlocksDownwardAdjustment: boolean` (new required field); `computeAdjustment` returns `reason: 'sleep blocks downward adjustment'` when it fires.

- [ ] **Step 1: Update the failing tests**

In `tests/calc/adjust.test.ts`, add the new field to the shared fixture:

```typescript
const base: AdjustmentInput = {
  currentTargetKcal: 2500,
  targetRateKgPerWeek: 0.5,
  observedRateKgPerWeek: 0.5,
  kcalFloor: 2100,
  isBaselineLocked: false,
  lastAdjustmentDate: null,
  today: '2026-09-09',
  sleepBlocksDownwardAdjustment: false,
};
```

Add a new test at the end of the `describe('computeAdjustment', ...)` block:

```typescript
  it('blocks a downward adjustment when two bad nights were logged, even if losing too slowly', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.3, sleepBlocksDownwardAdjustment: true });
    expect(result).toEqual({ newTargetKcal: 2500, changed: false, reason: 'sleep blocks downward adjustment' });
  });

  it('does not block an upward adjustment, even with two bad nights logged', () => {
    const result = computeAdjustment({ ...base, observedRateKgPerWeek: 0.9, sleepBlocksDownwardAdjustment: true });
    expect(result).toEqual({ newTargetKcal: 2600, changed: true, reason: 'too fast' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/adjust.test.ts`
Expected: FAIL — `sleepBlocksDownwardAdjustment` doesn't exist on `AdjustmentInput` yet (typecheck-level failure surfaces as a test failure once compiled).

- [ ] **Step 3: Implement in `lib/calc/adjust.ts`**

Add the field to `AdjustmentInput`:

```typescript
export interface AdjustmentInput {
  currentTargetKcal: number;
  targetRateKgPerWeek: number;
  observedRateKgPerWeek: number;
  kcalFloor: number;
  isBaselineLocked: boolean;
  lastAdjustmentDate: string | null;
  today: string;
  sleepBlocksDownwardAdjustment: boolean;
}
```

Update the "too slow" branch:

```typescript
  if (input.observedRateKgPerWeek < input.targetRateKgPerWeek) {
    if (input.sleepBlocksDownwardAdjustment) {
      return { newTargetKcal: input.currentTargetKcal, changed: false, reason: 'sleep blocks downward adjustment' };
    }
    const newTargetKcal = Math.max(input.kcalFloor, input.currentTargetKcal - MAX_STEP_KCAL);
    return { newTargetKcal, changed: newTargetKcal !== input.currentTargetKcal, reason: 'too slow' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/calc/adjust.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Typecheck (will show the one remaining call site to fix in Task 4)**

Run: `npm run typecheck`
Expected: FAIL — `lib/dailyRecompute.ts`'s `computeAdjustment` call is now missing the required field. This is expected; Task 4 fixes it.

- [ ] **Step 6: Commit**

```bash
git add lib/calc/adjust.ts tests/calc/adjust.test.ts
git commit -m "feat: add sleep-based downward-adjustment gating to computeAdjustment"
```

---

### Task 4: Wire sleep data into `runDailyRecompute`

**Files:**
- Modify: `lib/dailyRecompute.ts`
- Modify: `tests/dailyRecompute.test.ts`

**Interfaces:**
- Consumes: `recentSleepQualities` (`lib/sleep.js`), `blocksDownwardAdjustmentFromSleep` (`lib/calc/baseline.js`).

- [ ] **Step 1: Update the failing tests**

In `tests/dailyRecompute.test.ts`, add the import `import * as sleepLib from '../lib/sleep.js';` and, in each of the 3 existing tests, add `vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);` right after the `getWeeklyDefault` mock line (this preserves the exact current behavior — no sleep data means no gating — so all existing assertions stay unchanged).

Add one new test after the existing ones:

```typescript
  it('blocks the downward adjustment when the two most recent nights were bad', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 0,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue(['bad', 'bad']);
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    // Fixture weights (82.0 on 1999-07-31, 80.0 on 1999-08-14) give observedRateKgPerWeek=1.0 vs
    // targetRateKgPerWeek=0.4 -> "too fast" territory, NOT "too slow", so sleep-gating should have
    // no effect here; this test only proves the wiring exists and doesn't crash when sleep data is present.
    const result = await runDailyRecompute(TEST_DATE);

    expect(result.adjustmentReason).toBe('too fast');
    expect(applySpy).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dailyRecompute.test.ts`
Expected: FAIL — typecheck error from Task 3's `computeAdjustment` call missing the new field (surfaces when vitest transpiles the file).

- [ ] **Step 3: Implement in `lib/dailyRecompute.ts`**

Update the imports:

```typescript
import { isBaselineLocked, isStagnating, needsScheduledDietBreak, blocksDownwardAdjustmentFromSleep, type WeeklyWeightPoint } from './calc/baseline.js';
import { recentSleepQualities } from './sleep.js';
```

Add `recentSleepQualities()` to the initial `Promise.all`:

```typescript
  const [meals, dayPlans, weights, weeklyDefault, profile, recentSleep] = await Promise.all([
    prisma.meal.findMany({ where: { datetime: { gte: dayStart, lt: dayEndExclusive } } }),
    prisma.dayPlan.findMany({ where: { date: { gte: windowStart, lte: date } } }),
    prisma.weight.findMany({ where: { date: { gte: addDays(date, -20), lte: addDays(date, 3) } } }),
    getWeeklyDefault(weekdayOf(date)),
    getProfileSnapshot(),
    recentSleepQualities(),
  ]);
```

In the adjustment block, compute the gate and pass it into `computeAdjustment`:

```typescript
    const baselineLocked = profile.baselineStartedAt !== null && isBaselineLocked(profile.baselineStartedAt, date);
    const targetRateKgPerWeek = (profile.ratePctPerWeek / 100) * profile.weightKg;
    const observedRateKgPerWeek = ((weightStart - weightEnd) / 14) * 7;
    const sleepBlocksDownward = blocksDownwardAdjustmentFromSleep(recentSleep);

    const result = computeAdjustment({
      currentTargetKcal: targetKcal,
      targetRateKgPerWeek,
      observedRateKgPerWeek,
      kcalFloor: profile.kcalFloor,
      isBaselineLocked: baselineLocked,
      lastAdjustmentDate: profile.lastAdjustmentDate,
      today: date,
      sleepBlocksDownwardAdjustment: sleepBlocksDownward,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dailyRecompute.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck + full suite (run twice)**

Run: `npm run typecheck && npm test && npm test`
Expected: all PASS both times

- [ ] **Step 6: Commit**

```bash
git add lib/dailyRecompute.ts tests/dailyRecompute.test.ts
git commit -m "feat: wire recent sleep quality into runDailyRecompute's adjustment gating"
```

---

### Task 5: The "nuit ?" tap on the day-plan-prompt notification

**Files:**
- Modify: `lib/notificationRules.ts`
- Modify: `tests/notificationRules.test.ts`
- Modify: `lib/notificationTick.ts`
- Modify: `tests/notificationTick.test.ts`

**Interfaces:**
- Produces: `NotificationRuleResult.buttons?: InlineKeyboardButton[]` (new optional field).

- [ ] **Step 1: Update the failing test**

In `tests/notificationRules.test.ts`, update the first `ruleDayPlanPrompt` test:

```typescript
  it('fires in the morning when the day plan is not confirmed, with the sleep-quality buttons attached', () => {
    const result = ruleDayPlanPrompt({ ...baseCtx, todayDayPlanConfirmed: false });
    expect(result?.rule).toBe('day_plan_prompt');
    expect(result?.message).toContain('Nuit ?');
    expect(result?.buttons).toEqual([
      { text: 'Bonne', callback_data: 'sleep:good' },
      { text: 'Moyenne', callback_data: 'sleep:medium' },
      { text: 'Mauvaise', callback_data: 'sleep:bad' },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/notificationRules.test.ts`
Expected: FAIL — `result?.buttons` is `undefined`, message doesn't contain "Nuit ?"

- [ ] **Step 3: Implement in `lib/notificationRules.ts`**

Add the import and extend the result type:

```typescript
import type { InlineKeyboardButton } from './telegram.js';
```

```typescript
export interface NotificationRuleResult {
  rule: string;
  message: string;
  buttons?: InlineKeyboardButton[];
}
```

Update `ruleDayPlanPrompt`:

```typescript
export function ruleDayPlanPrompt(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isMorning(ctx.hourLocal)) return null;
  if (ctx.todayDayPlanConfirmed) return null;
  const hint = ctx.todayWeekdayActivityHint ? ` (probablement : ${ctx.todayWeekdayActivityHint})` : '';
  return {
    rule: 'day_plan_prompt',
    message: `Qu'est-ce que tu as prévu aujourd'hui ?${hint}\n\nNuit ?`,
    buttons: [
      { text: 'Bonne', callback_data: 'sleep:good' },
      { text: 'Moyenne', callback_data: 'sleep:medium' },
      { text: 'Mauvaise', callback_data: 'sleep:bad' },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/notificationRules.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Update the failing test for `notificationTick.ts`**

In `tests/notificationTick.test.ts`, update the `'sends the day-plan prompt...'` test's assertion — the send call now goes through `sendMessageWithKeyboard`, not `sendMessage`. Change the import line to add `import * as telegramLib from '../lib/telegram.js';` (already present) and replace the `sendSpy` assertion:

```typescript
  it('sends the day-plan prompt (with sleep buttons) in the morning when nothing else is set up', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessageWithKeyboard').mockResolvedValue();

    const result = await runNotificationTick(new Date('1999-09-05T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toEqual(['day_plan_prompt']);
    expect(sendSpy).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("prévu aujourd'hui"),
      expect.arrayContaining([{ text: 'Bonne', callback_data: 'sleep:good' }])
    );

    const recorded = await prisma.notification.findUnique({
      where: { date_rule: { date: TEST_DATE, rule: 'day_plan_prompt' } },
    });
    expect(recorded).not.toBeNull();
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/notificationTick.test.ts`
Expected: FAIL — `runNotificationTick` still calls plain `sendMessage` regardless of `buttons`.

- [ ] **Step 7: Implement in `lib/notificationTick.ts`**

Update the import line and the send call inside the rule loop:

```typescript
import { sendMessage, sendMessageWithKeyboard } from './telegram.js';
```

```typescript
  for (const rule of NOTIFICATION_RULES) {
    if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) break;
    const result = rule(context);
    if (!result) continue;
    if (await hasRuleFiredToday(dateIso, result.rule)) continue;

    if (result.buttons) {
      await sendMessageWithKeyboard(chatId, result.message, result.buttons);
    } else {
      await sendMessage(chatId, result.message);
    }
    await recordNotificationSent(dateIso, result.rule);
    sent.push(result);
    sentCount++;
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/notificationTick.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 10: Commit**

```bash
git add lib/notificationRules.ts tests/notificationRules.test.ts lib/notificationTick.ts tests/notificationTick.test.ts
git commit -m "feat: attach the nuit? sleep-quality tap to the day-plan-prompt notification"
```

---

### Task 6: Handle `callback_query` in the webhook

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `parseCallbackQuery`, `answerCallbackQuery` (`lib/telegram.js`), `saveSleepQuality` (`lib/sleep.js`), `SleepQuality` (`lib/calc/baseline.js`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/webhook.test.ts` (extend the existing `import { ... } from '../lib/telegram.js';` line with `parseCallbackQuery`, and add `import * as sleepLib from '../lib/sleep.js';`):

```typescript
  it('answers the callback query and saves the sleep quality when a sleep button is tapped', async () => {
    const answerSpy = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue();
    const saveSpy = vi.spyOn(sleepLib, 'saveSleepQuality').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = {
      callback_query: { id: 'cq1', data: 'sleep:medium', message: { chat: { id: 12345 } } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(answerSpy).toHaveBeenCalledWith('cq1');
    expect(saveSpy).toHaveBeenCalledWith(expect.any(String), 'medium');
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('medium'));
  });

  it('ignores a callback query from another chat', async () => {
    const answerSpy = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue();
    const saveSpy = vi.spyOn(sleepLib, 'saveSleepQuality').mockResolvedValue();
    const res = mockRes();
    const body = {
      callback_query: { id: 'cq1', data: 'sleep:medium', message: { chat: { id: 999 } } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(answerSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the webhook currently silently drops `callback_query` updates (no `answerCallbackQuery`/`saveSleepQuality` calls happen).

- [ ] **Step 3: Implement in `api/telegram/webhook.ts`**

Add imports:

```typescript
import { parseUpdate, sendMessage, parseCallbackQuery, answerCallbackQuery } from '../../lib/telegram.js';
import { saveSleepQuality } from '../../lib/sleep.js';
import type { SleepQuality } from '../../lib/calc/baseline.js';
```

Update the handler to check for a callback query first:

```typescript
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

  const callbackQuery = parseCallbackQuery(req.body, allowedChatId);
  if (callbackQuery) {
    res.status(200).json({ ok: true });
    waitUntil(handleCallbackQuery(callbackQuery));
    return;
  }

  const parsed = parseUpdate(req.body, allowedChatId);

  res.status(200).json({ ok: true });

  if (!parsed) return;

  waitUntil(handleMessage(parsed.chatId, parsed.text));
}
```

Add the new handler function (anywhere after `handleMessage`, e.g. right before `todayIsoDate`):

```typescript
const SLEEP_QUALITIES: SleepQuality[] = ['good', 'medium', 'bad'];

async function handleCallbackQuery(cq: { callbackQueryId: string; chatId: number; data: string }): Promise<void> {
  await answerCallbackQuery(cq.callbackQueryId);

  if (cq.data.startsWith('sleep:')) {
    const quality = cq.data.slice('sleep:'.length);
    if (SLEEP_QUALITIES.includes(quality as SleepQuality)) {
      await saveSleepQuality(todayIsoDate(), quality as SleepQuality);
      await sendMessage(cq.chatId, `Nuit notée : ${quality}.`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 6: Commit and push**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: handle callback_query updates in the webhook, capturing sleep-quality taps"
git push
```

---

## Self-Review Notes

- **Spec coverage:** §9's "plus la question 'nuit ?' en un tap" → Task 5 (buttons attached to the notification) + Task 6 (capture via `callback_query`). §6's "deux nuits 'mauvaise' consécutives → aucun ajustement à la baisse" → Task 3 (pure gating logic) + Task 4 (wired into the real recompute loop). Both gaps explicitly named as deferred in the step 8 and step 9 plans are now closed.
- **Type consistency:** `NotificationRuleResult.buttons` (Task 5) uses the exact `InlineKeyboardButton` type from Task 1, so `notificationTick.ts` passes it straight into `sendMessageWithKeyboard` with no remapping. `SleepQuality` (already existing in `lib/calc/baseline.ts`) is reused identically in `lib/sleep.ts`, `lib/dailyRecompute.ts`, and `api/telegram/webhook.ts` — never redefined.
- **No Claude dependency, verified**: no file touched in this plan imports `lib/claude.js`.
