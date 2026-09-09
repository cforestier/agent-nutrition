# Saisie de repas décrite en langage naturel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user log a meal described in plain language ("une assiette de pâtes bolognaise") — Claude estimates the items, macros, and a calorie **range** (never a single number), and calls a tool to save it. This is the "décrite" tier from spec §7 — the middle reliability tier, above photo, below weighed (weighed still blocked on the Ciqual/OSAV dataset).

**Architecture:** `Meal` is a plain accumulating Mongo collection (many rows per day, no unique-key/singleton concerns) — same single-file, live-tested pattern as `scenarios.ts`/`weight.ts`, no store-file split needed. `lib/meals.ts` holds the tool schema, the Prisma write, and the dispatch handler together. Added to the same always-available `GENERAL_CHAT_TOOLS` array in the webhook as scenarios/weekly-schedule/weight — the established pattern from the previous three plans, no new routing branch.

**Tech Stack:** Same as prior steps — Prisma/MongoDB (with the `Json`-field cast pattern from step 5), Vitest live-tested, `@anthropic-ai/sdk` manual tool-use loop.

**Spec:** `docs/spec-agent-nutrition-v4.md` §7 ("Saisie" — three modes by reliability; this implements mode 2, "décrite", `confidence: 'medium'`), §11 (`meals` table: `datetime, inputType, telegramFileId, rawDescription, items, kcalLow/Mid/High, confidence, userCorrected`). §5/§6 note: the range-not-a-point-estimate rule exists because "le biais des modes 2 et 3 est absorbé par la boucle §6, puisque la maintenance vient du poids réel et non des calories saisies" — this plan's job is only to *capture* the estimate correctly, not to reconcile it against anything (that's the still-unbuilt adaptation loop, step 8).

## Global Constraints

- **Always a range (`kcalLow`/`kcalMid`/`kcalHigh`), never a single number** — enforced by the tool schema requiring all three fields, and stated explicitly in the tool description so the model doesn't collapse them to one estimate.
- `inputType` is hardcoded `'text'` and `confidence` hardcoded `'medium'` in this tool — this is specifically the *described* mode; the photo mode (still deferred — needs a real Telegram photo message to test against) would be a different tool/handler with `inputType: 'photo'` and `confidence: 'low'`, not a parameter on this one.
- `items` is a `Json` Prisma field — cast with `as unknown as Prisma.InputJsonValue` per the established rule from step 5's memory note.
- `userCorrected` defaults to `false` — there's no correction flow yet (that's a future one-tap-correction UI concern from spec §7, out of scope here).

---

## File Structure

```
/lib
  meals.ts        # LOG_MEAL_TOOL, LogMealInput, MealItem, handleLogMealTool()
/api/telegram/webhook.ts   # modified: add LOG_MEAL_TOOL to the general-chat toolset
/prisma/schema.prisma       # add Meal model
/tests
  meals.test.ts
  webhook.test.ts            # modified: general-chat tool list includes LOG_MEAL_TOOL
```

---

### Task 1: Prisma `Meal` model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the model**

```prisma
model Meal {
  id             String   @id @default(auto()) @map("_id") @db.ObjectId
  datetime       DateTime @default(now())
  inputType      String
  telegramFileId String?
  rawDescription String
  items          Json
  kcalLow        Float
  kcalMid        Float
  kcalHigh       Float
  confidence     String
  userCorrected  Boolean  @default(false)
  createdAt      DateTime @default(now())
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add Meal model"
```

---

### Task 2: `lib/meals.ts`

**Files:**
- Create: `lib/meals.ts`
- Test: `tests/meals.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` from `lib/claude.ts`.
- Produces:
  - `export interface MealItem { name: string; estimatedGrams: number; kcal: number; proteinG: number; carbsG: number; fatG: number }`
  - `export interface LogMealInput { rawDescription: string; items: MealItem[]; kcalLow: number; kcalMid: number; kcalHigh: number }`
  - `export const LOG_MEAL_TOOL: ToolDefinition`
  - `handleLogMealTool(rawInput: Record<string, unknown>): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/meals.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogMealTool } from '../lib/meals.js';

describe('handleLogMealTool', () => {
  const marker = `test-${Date.now()}-pates-bolognaise`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.meal.delete({ where: { id: createdId } });
  });

  it('saves a described meal with a calorie range and returns a confirmation', async () => {
    const result = await handleLogMealTool({
      rawDescription: marker,
      items: [
        { name: 'pâtes', estimatedGrams: 250, kcal: 350, proteinG: 12, carbsG: 70, fatG: 2 },
        { name: 'sauce bolognaise', estimatedGrams: 150, kcal: 220, proteinG: 15, carbsG: 8, fatG: 14 },
      ],
      kcalLow: 500,
      kcalMid: 570,
      kcalHigh: 650,
    });

    expect(result).toContain('500');
    expect(result).toContain('650');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: marker } });
    createdId = saved?.id;
    expect(saved?.inputType).toBe('text');
    expect(saved?.confidence).toBe('medium');
    expect(saved?.userCorrected).toBe(false);
    expect(saved?.kcalLow).toBe(500);
    expect(saved?.kcalHigh).toBe(650);
    expect(saved?.items).toEqual([
      { name: 'pâtes', estimatedGrams: 250, kcal: 350, proteinG: 12, carbsG: 70, fatG: 2 },
      { name: 'sauce bolognaise', estimatedGrams: 150, kcal: 220, proteinG: 15, carbsG: 8, fatG: 14 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/meals.test.ts`
Expected: FAIL — `Cannot find module '../lib/meals.js'`.

- [ ] **Step 3: Create `lib/meals.ts`**

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import type { ToolDefinition } from './claude.js';

export interface MealItem {
  name: string;
  estimatedGrams: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface LogMealInput {
  rawDescription: string;
  items: MealItem[];
  kcalLow: number;
  kcalMid: number;
  kcalHigh: number;
}

export const LOG_MEAL_TOOL: ToolDefinition = {
  name: 'log_meal',
  description:
    "Enregistre un repas décrit en langage naturel par l'utilisateur. Estime les aliments, leurs macronutriments, et donne TOUJOURS une fourchette calorique (kcalLow/kcalMid/kcalHigh) — jamais un chiffre unique, l'estimation par description reste approximative.",
  input_schema: {
    type: 'object',
    properties: {
      rawDescription: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            estimatedGrams: { type: 'number' },
            kcal: { type: 'number' },
            proteinG: { type: 'number' },
            carbsG: { type: 'number' },
            fatG: { type: 'number' },
          },
          required: ['name', 'estimatedGrams', 'kcal', 'proteinG', 'carbsG', 'fatG'],
        },
      },
      kcalLow: { type: 'number' },
      kcalMid: { type: 'number' },
      kcalHigh: { type: 'number' },
    },
    required: ['rawDescription', 'items', 'kcalLow', 'kcalMid', 'kcalHigh'],
  },
};

export async function handleLogMealTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogMealInput;

  await prisma.meal.create({
    data: {
      inputType: 'text',
      rawDescription: input.rawDescription,
      items: input.items as unknown as Prisma.InputJsonValue,
      kcalLow: input.kcalLow,
      kcalMid: input.kcalMid,
      kcalHigh: input.kcalHigh,
      confidence: 'medium',
      userCorrected: false,
    },
  });

  return `Repas enregistré : ${input.kcalLow}-${input.kcalHigh} kcal (estimation ~${input.kcalMid} kcal), confiance moyenne.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/meals.test.ts`
Expected: PASS (1 test) — live against the real Atlas cluster, cleaned up via `afterAll`.

- [ ] **Step 5: Commit**

```bash
git add lib/meals.ts tests/meals.test.ts
git commit -m "feat: described-meal logging tool"
```

---

### Task 3: Offer the tool in general chat

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

- [ ] **Step 1: Update the failing test**

```ts
// tests/webhook.test.ts — add this import
import { LOG_MEAL_TOOL } from '../lib/meals.js';
```

```ts
// in the "responds 200 and replies with Claude's answer..." test, update the assertion:
expect(converseWithToolSpy).toHaveBeenCalledWith(
  'full system prompt',
  [],
  'salut',
  [...scenariosLib.SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL, LOG_WEIGHT_TOOL, LOG_MEAL_TOOL],
  expect.any(Function)
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the webhook doesn't offer `LOG_MEAL_TOOL` yet.

- [ ] **Step 3: Update `api/telegram/webhook.ts`**

```ts
// add this import alongside the existing lib/weight.js import
import { LOG_MEAL_TOOL, handleLogMealTool } from '../../lib/meals.js';
```

```ts
// replace GENERAL_CHAT_TOOLS and handleGeneralChatTool
const GENERAL_CHAT_TOOLS = [...SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL, LOG_WEIGHT_TOOL, LOG_MEAL_TOOL];

async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  return handleScenarioTool(name, input);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass, no type errors.

- [ ] **Step 6: Commit and push**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: offer described-meal logging in general chat"
git push
```

---

## Self-Review

**Spec coverage:** "décrite" mode from §7 ✅ (`confidence: 'medium'`, always a range). `meals` table shape from §11 ✅ (`datetime` uses Prisma's `@default(now())` rather than a passed-in value — no call site needs a custom datetime yet, since there's no "log a meal from earlier today" feature; add that parameter when it's actually needed). Weighed mode (still blocked on Ciqual) and photo mode (still blocked on needing a real photo to test against) are correctly out of scope, not silently skipped.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `MealItem`/`LogMealInput` (Task 2) match `LOG_MEAL_TOOL`'s schema fields exactly and are the same shape the Task 2 test constructs and asserts against. `GENERAL_CHAT_TOOLS` (Task 3) matches the array literal asserted in the updated webhook test, appended in the same order as the three prior tools.
