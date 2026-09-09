# Saisie du poids en langage naturel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user log their weight in plain conversation ("80.5kg ce matin") — Claude extracts the date and value and calls a tool to save it. Foundational: the future adaptation loop, weekly weigh-in reminder, and rapid-loss guardrail (already built in `/lib/calc/guardrails.ts`) all need weight history to exist before they can run.

**Architecture:** `Weight` is a plain accumulating Mongo collection (one row per date, `@unique` on `date`, upserted so a same-day correction overwrites rather than duplicates) — **not** a fixed-tiny-keyspace singleton like `Profile`/`WeeklyDefault`, so it follows the `scenarios.ts`/`messages.ts` pattern: one file, Prisma calls live-tested directly against the real Atlas cluster with a fixed test date cleaned up afterward, no `vi.spyOn` split needed. `lib/weight.ts` holds the tool schema, the Prisma upsert, and the dispatch handler together. The tool is added to the same always-available general-chat toolset as scenarios/weekly-schedule — no new routing branch.

**Tech Stack:** Same as prior steps — Prisma/MongoDB, Vitest live-tested (marker/fixed-date cleanup), `@anthropic-ai/sdk` manual tool-use loop (already generalized to multiple tools).

**Spec:** `docs/spec-agent-nutrition-v4.md` §7 ("Saisie" — weight logging is the simplest of the input modes), §11 (`weights` table: `date, weightKg, source`). `source` is always `'manual'` here — `'scan'` is reserved for the still-deferred body-scan PDF parsing step.

## Global Constraints

- `Weight.date` is `YYYY-MM-DD`, `@unique` — a second log for the same date **overwrites** (upsert), matching how a same-day re-weigh should behave; it does not create a duplicate row.
- `source` is hardcoded to `'manual'` in `saveWeight` — there is no path yet that would set `'scan'`, so don't add a parameter for it prematurely (YAGNI; step 3 will add that when the PDF parser exists).
- No system-prompt gating or "propose this" nudge is needed for this tool (unlike the weekly-schedule tool) — a clear, prescriptive `description` on the tool itself is the documented best practice for when-to-call guidance, and there's no empty/non-empty state to react to.

---

## File Structure

```
/lib
  weight.ts       # LOG_WEIGHT_TOOL, WeightEntry, saveWeight(), handleLogWeightTool()
/api/telegram/webhook.ts   # modified: add LOG_WEIGHT_TOOL to the general-chat toolset
/prisma/schema.prisma       # add Weight model
/tests
  weight.test.ts
  webhook.test.ts            # modified: general-chat tool list includes LOG_WEIGHT_TOOL
```

---

### Task 1: Prisma `Weight` model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the model**

```prisma
model Weight {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  date      String   @unique
  weightKg  Float
  source    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add Weight model"
```

---

### Task 2: `lib/weight.ts`

**Files:**
- Create: `lib/weight.ts`
- Test: `tests/weight.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` from `lib/claude.ts`.
- Produces:
  - `export interface WeightEntry { date: string; weightKg: number }`
  - `export const LOG_WEIGHT_TOOL: ToolDefinition`
  - `saveWeight(entry: WeightEntry): Promise<void>`
  - `handleLogWeightTool(rawInput: Record<string, unknown>): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weight.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveWeight, handleLogWeightTool } from '../lib/weight.js';

describe('weight logging', () => {
  const testDate = '1999-06-15';

  afterAll(async () => {
    await prisma.weight.deleteMany({ where: { date: testDate } });
  });

  it('creates a weight entry with source manual', async () => {
    await saveWeight({ date: testDate, weightKg: 80.5 });
    const saved = await prisma.weight.findUnique({ where: { date: testDate } });
    expect(saved?.weightKg).toBe(80.5);
    expect(saved?.source).toBe('manual');
  });

  it('overwrites the same date instead of duplicating on a second log', async () => {
    await saveWeight({ date: testDate, weightKg: 79.9 });
    const saved = await prisma.weight.findUnique({ where: { date: testDate } });
    expect(saved?.weightKg).toBe(79.9);
    const count = await prisma.weight.count({ where: { date: testDate } });
    expect(count).toBe(1);
  });

  it('handleLogWeightTool saves and returns a confirmation message', async () => {
    const result = await handleLogWeightTool({ date: testDate, weightKg: 78.2 });
    expect(result).toContain(testDate);
    expect(result).toContain('78.2');
    const saved = await prisma.weight.findUnique({ where: { date: testDate } });
    expect(saved?.weightKg).toBe(78.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/weight.test.ts`
Expected: FAIL — `Cannot find module '../lib/weight.js'`.

- [ ] **Step 3: Create `lib/weight.ts`**

```ts
import { prisma } from './db.js';
import type { ToolDefinition } from './claude.js';

export interface WeightEntry {
  date: string;
  weightKg: number;
}

export const LOG_WEIGHT_TOOL: ToolDefinition = {
  name: 'log_weight',
  description:
    "Enregistre le poids de l'utilisateur pour une date donnée (aujourd'hui par défaut, sauf indication contraire de l'utilisateur). Un nouveau relevé pour la même date remplace le précédent.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      weightKg: { type: 'number' },
    },
    required: ['date', 'weightKg'],
  },
};

export async function saveWeight(entry: WeightEntry): Promise<void> {
  await prisma.weight.upsert({
    where: { date: entry.date },
    create: { date: entry.date, weightKg: entry.weightKg, source: 'manual' },
    update: { weightKg: entry.weightKg, source: 'manual' },
  });
}

export async function handleLogWeightTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as WeightEntry;
  await saveWeight(input);
  return `Poids du ${input.date} enregistré : ${input.weightKg} kg.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/weight.test.ts`
Expected: PASS (3 tests) — live against the real Atlas cluster, cleaned up via `afterAll`.

- [ ] **Step 5: Commit**

```bash
git add lib/weight.ts tests/weight.test.ts
git commit -m "feat: weight logging tool"
```

---

### Task 3: Offer the tool in general chat

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

- [ ] **Step 1: Update the failing test**

```ts
// tests/webhook.test.ts — add this import
import { LOG_WEIGHT_TOOL } from '../lib/weight.js';
```

```ts
// in the "responds 200 and replies with Claude's answer..." test, update the assertion:
expect(converseWithToolSpy).toHaveBeenCalledWith(
  'full system prompt',
  [],
  'salut',
  [...scenariosLib.SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL, LOG_WEIGHT_TOOL],
  expect.any(Function)
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the webhook doesn't offer `LOG_WEIGHT_TOOL` yet.

- [ ] **Step 3: Update `api/telegram/webhook.ts`**

```ts
// add this import alongside the existing lib/weeklySchedule.js import
import { LOG_WEIGHT_TOOL, handleLogWeightTool } from '../../lib/weight.js';
```

```ts
// replace GENERAL_CHAT_TOOLS and handleGeneralChatTool
const GENERAL_CHAT_TOOLS = [...SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL, LOG_WEIGHT_TOOL];

async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  return handleScenarioTool(name, input);
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
git commit -m "feat: offer weight logging in general chat"
```

---

## Self-Review

**Spec coverage:** `weights` table shape (§11: `date, weightKg, source`) ✅ — `source` fixed to `'manual'`, documented as deliberate (Global Constraints) rather than a gap, since `'scan'` has no producer yet. Simplest input mode from §7 ✅.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `WeightEntry { date, weightKg }` (Task 2) matches `LOG_WEIGHT_TOOL`'s required fields exactly and is the same shape `handleLogWeightTool` destructures. `GENERAL_CHAT_TOOLS` (Task 3) matches the array literal asserted in the updated webhook test.
