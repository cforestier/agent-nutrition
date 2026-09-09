# Étape 5b — Semaine type construite par l'utilisateur (jour / activité / dépense moyenne) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instead of pre-filling the spec's example week (Lundi bureau chez Rémi, etc. — generic scaffolding from the spec draft, not this user's real life), let the user build their own standard week one entry at a time: for each day with a recurring activity, they give the activity type and its average caloric expenditure. Claude proposes building it, asks day by day (or accepts several at once), and calls a tool to save it — additive, correctable, never a rigid form.

**Architecture:** A new, deliberately separate concept from `Scenario`/`DayPlan` (the NLP-resolved-per-message system from step 5) — `WeeklyDefault` is a simple per-weekday lookup (`weekday → activityType, avgKcal`), one row per weekday (`@unique` on `weekday`). Split the same way `onboarding.ts`/`profile.ts` are split: `lib/weeklySchedule.ts` holds the tool schema and the pure dispatch logic, `lib/weeklyScheduleStore.ts` holds the one Prisma-touching module — so tests can `vi.spyOn` the store from outside, and so the tool logic is testable without ever writing to the real collection. The tool is offered alongside the scenario tools in the general-chat branch (not a separate routing mode) — proposing to build the week is something Claude does conversationally when it notices the schedule is still empty, via a system-prompt addition, exactly like scenario resolution already works.

**Tech Stack:** Same as steps 4/4a/5 — `@anthropic-ai/sdk` manual tool-use loop (already generalized to multiple tools in step 5), Prisma/MongoDB, Vitest.

**Spec:** `docs/spec-agent-nutrition-v4.md` §4 (onboarding mentions "scénarios de base — l'agent propose la semaine standard, l'utilisateur corrige") — this plan implements a user-driven version of that idea rather than the spec's literal pre-filled example, per explicit user instruction. §5 ("estimation des segments du day_plan" feeds the *predicted* TDEE only) is the reason `avgKcal` is safe to store here: it's an input to the predicted-TDEE estimate, never a substitute for the observed-TDEE loop in `/lib/calc`.

## Global Constraints

- **`WeeklyDefault.weekday` has only 7 possible values, one row each (`@unique`).** Exactly like `Profile`, once the user has set real weekly-schedule data, a test that upserts by weekday against the live cluster would silently overwrite it. Same rule as `Profile`: `lib/weeklyScheduleStore.ts` (the Prisma-touching module) has **no test file** — reviewed by hand, same trust level as `lib/profile.ts`. Everything in `lib/weeklySchedule.ts` that calls it is tested via `vi.spyOn` on the imported store module, never live.
- `avgKcal` is rounded to the nearest integer before saving (`Math.round`) — the model may send a decimal, the field is an `Int`.
- This tool is **offered continuously in general chat**, not a blocking onboarding gate — the user can build the week whenever they want, or never, and nothing else depends on it existing yet.

---

## File Structure

```
/lib
  weeklySchedule.ts       # SET_WEEKLY_SCHEDULE_TOOL, WEEKDAYS, WeeklyScheduleEntry, handleWeeklyScheduleTool()
  weeklyScheduleStore.ts  # saveWeeklySchedule(), hasWeeklySchedule(), weeklyScheduleSystemPromptAddition()
/api/telegram/webhook.ts   # modified: combine scenario + weekly-schedule tools/handlers/prompt
/prisma/schema.prisma       # add WeeklyDefault model
/tests
  weekly-schedule.test.ts
  webhook.test.ts            # modified: general-chat branch now combines two toolsets
```

---

### Task 1: Prisma `WeeklyDefault` model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the model**

```prisma
model WeeklyDefault {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  weekday      String   @unique
  activityType String
  avgKcal      Int
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add WeeklyDefault model"
```

---

### Task 2: `lib/weeklyScheduleStore.ts` and `lib/weeklySchedule.ts`

**Files:**
- Create: `lib/weeklyScheduleStore.ts`
- Create: `lib/weeklySchedule.ts`
- Test: `tests/weekly-schedule.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` from `lib/claude.ts`.
- Produces:
  - `export const WEEKDAYS: readonly ['monday', ..., 'sunday']`
  - `export type Weekday = typeof WEEKDAYS[number]`
  - `export interface WeeklyScheduleEntry { weekday: Weekday; activityType: string; avgKcal: number }`
  - `export const SET_WEEKLY_SCHEDULE_TOOL: ToolDefinition`
  - `handleWeeklyScheduleTool(input: Record<string, unknown>): Promise<string>` (in `weeklySchedule.ts`)
  - `saveWeeklySchedule(entries: WeeklyScheduleEntry[]): Promise<void>`, `hasWeeklySchedule(): Promise<boolean>`, `weeklyScheduleSystemPromptAddition(): Promise<string>` (in `weeklyScheduleStore.ts`)

- [ ] **Step 1: Create `lib/weeklyScheduleStore.ts`** (no test file — see Global Constraints)

```ts
import { prisma } from './db.js';
import type { Weekday, WeeklyScheduleEntry } from './weeklySchedule.js';

export async function saveWeeklySchedule(entries: WeeklyScheduleEntry[]): Promise<void> {
  await Promise.all(
    entries.map((entry) =>
      prisma.weeklyDefault.upsert({
        where: { weekday: entry.weekday },
        create: { weekday: entry.weekday, activityType: entry.activityType, avgKcal: Math.round(entry.avgKcal) },
        update: { activityType: entry.activityType, avgKcal: Math.round(entry.avgKcal) },
      })
    )
  );
}

export async function hasWeeklySchedule(): Promise<boolean> {
  const count = await prisma.weeklyDefault.count();
  return count > 0;
}

export async function weeklyScheduleSystemPromptAddition(): Promise<string> {
  const has = await hasWeeklySchedule();
  if (has) return '';

  return `

L'utilisateur n'a pas encore défini sa semaine type. Propose-lui de la construire avec toi, jour par jour : pour chaque jour où il y a une activité récurrente, demande le type d'activité et sa dépense calorique moyenne, puis appelle set_weekly_schedule (plusieurs jours à la fois si l'utilisateur les donne d'un coup). Ne force rien : s'il préfère faire ça plus tard, n'insiste pas.`;
}
```

Note: this file imports the `Weekday`/`WeeklyScheduleEntry` **types** from `weeklySchedule.ts` (Step 2 below), while `weeklySchedule.ts` imports the **functions** from this file — a type-only/value-only split, so there is no runtime circular dependency (TypeScript erases type-only imports).

- [ ] **Step 2: Write the failing test**

```ts
// tests/weekly-schedule.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as store from '../lib/weeklyScheduleStore.js';
import { handleWeeklyScheduleTool } from '../lib/weeklySchedule.js';

describe('handleWeeklyScheduleTool', () => {
  it('rounds avgKcal and forwards entries to the store, returning a summary', async () => {
    const saveSpy = vi.spyOn(store, 'saveWeeklySchedule').mockResolvedValue();

    const result = await handleWeeklyScheduleTool({
      entries: [
        { weekday: 'monday', activityType: 'vélo', avgKcal: 350.6 },
        { weekday: 'thursday', activityType: 'crossfit', avgKcal: 500 },
      ],
    });

    expect(saveSpy).toHaveBeenCalledWith([
      { weekday: 'monday', activityType: 'vélo', avgKcal: 350.6 },
      { weekday: 'thursday', activityType: 'crossfit', avgKcal: 500 },
    ]);
    expect(result).toContain('monday: vélo');
    expect(result).toContain('thursday: crossfit');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/weekly-schedule.test.ts`
Expected: FAIL — `Cannot find module '../lib/weeklySchedule.js'`.

- [ ] **Step 4: Create `lib/weeklySchedule.ts`**

```ts
import { saveWeeklySchedule } from './weeklyScheduleStore.js';
import type { ToolDefinition } from './claude.js';

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface WeeklyScheduleEntry {
  weekday: Weekday;
  activityType: string;
  avgKcal: number;
}

export const SET_WEEKLY_SCHEDULE_TOOL: ToolDefinition = {
  name: 'set_weekly_schedule',
  description:
    "Enregistre ou met à jour un ou plusieurs jours de la semaine type de l'utilisateur : jour, type d'activité, dépense calorique moyenne pour cette activité. Peut être appelé plusieurs fois pour compléter ou corriger la semaine au fil de la conversation.",
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            weekday: { type: 'string', enum: [...WEEKDAYS] },
            activityType: { type: 'string' },
            avgKcal: { type: 'number' },
          },
          required: ['weekday', 'activityType', 'avgKcal'],
        },
      },
    },
    required: ['entries'],
  },
};

export async function handleWeeklyScheduleTool(rawInput: Record<string, unknown>): Promise<string> {
  const { entries } = rawInput as unknown as { entries: WeeklyScheduleEntry[] };
  await saveWeeklySchedule(entries);
  const summary = entries.map((e) => `${e.weekday}: ${e.activityType} (~${e.avgKcal} kcal)`).join(', ');
  return `Semaine type mise à jour : ${summary}.`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/weekly-schedule.test.ts`
Expected: PASS (1 test) — `saveWeeklySchedule` mocked, no real database write.

- [ ] **Step 6: Commit**

```bash
git add lib/weeklySchedule.ts lib/weeklyScheduleStore.ts tests/weekly-schedule.test.ts
git commit -m "feat: user-built weekly schedule (day, activity, avg kcal)"
```

---

### Task 3: Offer the tool in general chat

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `SET_WEEKLY_SCHEDULE_TOOL`, `handleWeeklyScheduleTool` from `lib/weeklySchedule.ts`; `weeklyScheduleSystemPromptAddition` from `lib/weeklyScheduleStore.ts`; `SCENARIO_TOOLS`, `handleScenarioTool`, `buildScenarioSystemPrompt` from `lib/scenarios.ts` (unchanged from step 5).

- [ ] **Step 1: Update the failing test**

```ts
// tests/webhook.test.ts — add these imports
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';
import { SET_WEEKLY_SCHEDULE_TOOL, handleWeeklyScheduleTool } from '../lib/weeklySchedule.js';
```

```ts
// replace the "responds 200 and replies with Claude's answer..." test
it("responds 200 and replies with Claude's answer from the allowed chat", async () => {
  vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(true);
  vi.spyOn(scenariosLib, 'buildScenarioSystemPrompt').mockResolvedValue('full system prompt');
  vi.spyOn(weeklyScheduleStoreLib, 'weeklyScheduleSystemPromptAddition').mockResolvedValue('');
  vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
  const converseWithToolSpy = vi
    .spyOn(claudeLib, 'converseWithTool')
    .mockResolvedValue({ text: 'Bonjour !', outputTokens: 5 });
  const saveSpy = vi.spyOn(messagesLib, 'saveMessage').mockResolvedValue();
  const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
  const res = mockRes();
  const body = { message: { chat: { id: 12345 }, text: 'salut' } };

  await handler({ method: 'POST', body } as any, res as any);
  await flushBackgroundTasks();

  expect(res.statusCode).toBe(200);
  expect(converseWithToolSpy).toHaveBeenCalledWith(
    'full system prompt',
    [],
    'salut',
    [...scenariosLib.SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL],
    expect.any(Function)
  );
  expect(saveSpy).toHaveBeenCalledWith('user', 'salut');
  expect(saveSpy).toHaveBeenCalledWith('assistant', 'Bonjour !', 5);
  expect(sendSpy).toHaveBeenCalledWith(12345, 'Bonjour !');
});
```

- [ ] **Step 2: Run tests to verify the assertion fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the webhook still only offers `SCENARIO_TOOLS` and `handleScenarioTool` directly.

- [ ] **Step 3: Update `api/telegram/webhook.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';
import { converseWithTool } from '../../lib/claude.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';
import { isOnboardingBasicsComplete } from '../../lib/profile.js';
import { ONBOARDING_SYSTEM_PROMPT, ONBOARDING_TOOL, handleOnboardingTool } from '../../lib/onboarding.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { SCENARIO_TOOLS, handleScenarioTool, buildScenarioSystemPrompt } from '../../lib/scenarios.js';
import { SET_WEEKLY_SCHEDULE_TOOL, handleWeeklyScheduleTool } from '../../lib/weeklySchedule.js';
import { weeklyScheduleSystemPromptAddition } from '../../lib/weeklyScheduleStore.js';

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

const GENERAL_CHAT_TOOLS = [...SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL];

async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  return handleScenarioTool(name, input);
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(10);
  const onboardingDone = await isOnboardingBasicsComplete();

  const result = onboardingDone
    ? await converseWithTool(
        (await buildScenarioSystemPrompt(SYSTEM_PROMPT, todayIsoDate())) + (await weeklyScheduleSystemPromptAddition()),
        history,
        text,
        GENERAL_CHAT_TOOLS,
        handleGeneralChatTool
      )
    : await converseWithTool(
        ONBOARDING_SYSTEM_PROMPT,
        history,
        text,
        [ONBOARDING_TOOL],
        (_name, input) => handleOnboardingTool(input)
      );

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: offer the weekly-schedule tool alongside scenario tools in general chat"
```

---

## Self-Review

**Spec coverage:** the spec's own "propose la semaine standard" idea (§4) is implemented in a user-driven form per explicit instruction, rather than pre-filling the spec's example week — documented as a deliberate deviation in the Spec line above, not a silent gap. `avgKcal` maps to §5's "estimation des segments du day_plan" feeding the predicted TDEE only ✅ — nothing here touches the observed-TDEE loop.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `WeeklyScheduleEntry` (Task 2, defined in `weeklySchedule.ts`) is imported as a type-only reference into `weeklyScheduleStore.ts`'s `saveWeeklySchedule` parameter — same shape used in the Task 2 test's mock assertion and in `handleWeeklyScheduleTool`'s destructured input. `SET_WEEKLY_SCHEDULE_TOOL`'s `entries[].weekday` enum values match `WEEKDAYS` exactly (spread into the schema, not hand-duplicated, so they can't drift).
