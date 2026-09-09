# Garde-fous comportementaux (§10 #4 et #7) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two behavioral guardrails from spec §10 that were deliberately deferred when `/lib/calc` and onboarding were built (they're language-driven, not deterministic math): **#4** detecting eating-disorder-adjacent language (excessive restriction, food guilt, compensatory behavior, number obsession) and **#7** never giving medical advice. Detection is necessarily the model's job — no code can parse "I feel guilty when I eat" — but the spec is explicit that enforcement must be **hard-coded, not just prompted** ("un prompt se contourne en trois messages"). So: the model calls a tool the moment it notices a signal, that tool flips a **persistent** flag in the database, and — this is the hard-coded part — any code that will ever hand back a numeric target checks that flag first and refuses, regardless of what the conversation says afterward.

**Architecture:** `Profile.edSignalFlagged` (persistent, `Profile` being the mono-user singleton already used for onboarding state) is set by a new `flag_concern` tool, available in **both** the onboarding and general-chat toolsets since concerning language can surface at any point in the conversation. `lib/onboarding.ts`'s `handleOnboardingTool` — the only place in the codebase that currently hands back a numeric target (rate %, protein grams) — is updated to check the flag first and refuse if set, establishing the pattern every future target-producing function (the still-unbuilt daily recompute, step 8) must follow. `SAFETY_GUARDRAILS_PROMPT` is a shared string appended to both system prompts (onboarding and general chat) — the prompt text drives *detection*, the code-level flag check drives *enforcement*, matching the spec's split.

**Tech Stack:** Same as prior steps — Prisma/MongoDB, Vitest (`Profile` follows the existing singleton-testing rule: `flagEdSignal`/`isEdSignalFlagged` live in `lib/profile.ts`, no test file, everything that calls them is tested via `vi.spyOn`), `@anthropic-ai/sdk` manual tool-use loop.

**Spec:** `docs/spec-agent-nutrition-v4.md` §10 #4 (ED-signal detection, persistent, no auto-reset) and #7 (no medical advice).

## Global Constraints

- **`edSignalFlagged` never auto-resets.** There is no code path in this plan (or planned anywhere) that sets it back to `false` — per spec, this state is deliberately one-way; only manual intervention (e.g. a future admin action) could ever clear it, and nothing here builds that.
- **Enforcement lives in code, not just in the prompt.** `handleOnboardingTool` checks `isEdSignalFlagged()` before computing anything — this is the concrete instance of the rule "guardrails are hard-coded, outside the system prompt." Any future function that would return a kcal/rate/macro target to the user must add the same check at the top, before doing its own work — noted here so it isn't forgotten when the step-8 recompute loop is eventually built.
- `flag_concern` must not be called lightly — its own tool `description` says so explicitly, since an over-triggering flag would block target-setting for a user who was just making an offhand comment.

---

## File Structure

```
/lib
  profile.ts      # modified: flagEdSignal(), isEdSignalFlagged() (no test file — singleton rule)
  safety.ts        # FLAG_CONCERN_TOOL, SAFETY_GUARDRAILS_PROMPT, handleFlagConcernTool()
  onboarding.ts     # modified: handleOnboardingTool checks isEdSignalFlagged() first
/api/telegram/webhook.ts   # modified: FLAG_CONCERN_TOOL in both toolsets, SAFETY_GUARDRAILS_PROMPT appended to both prompts
/prisma/schema.prisma       # extend Profile with edSignalFlagged, edSignalNote
/tests
  safety.test.ts
  onboarding.test.ts          # modified: new blocked-when-flagged test
  webhook.test.ts             # modified: both toolsets/prompts updated
```

---

### Task 1: Extend `Profile`, add flag functions to `lib/profile.ts`

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `lib/profile.ts`

- [ ] **Step 1: Extend the `Profile` model**

```prisma
// add these two fields to the existing Profile model in prisma/schema.prisma
  edSignalFlagged          Boolean   @default(false)
  edSignalNote             String?
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Add flag functions to `lib/profile.ts`** (no test file — see Global Constraints / the existing singleton rule already applied to this file)

```ts
// append to lib/profile.ts
export async function flagEdSignal(reason: string): Promise<void> {
  const existing = await prisma.profile.findFirst();
  const data = { edSignalFlagged: true, edSignalNote: reason };
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}

export async function isEdSignalFlagged(): Promise<boolean> {
  const profile = await prisma.profile.findFirst();
  return profile?.edSignalFlagged ?? false;
}
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma lib/profile.ts
git commit -m "feat: persistent ED-signal flag on Profile"
git push
```

---

### Task 2: `lib/safety.ts` — the tool, its handler, and the shared prompt text

**Files:**
- Create: `lib/safety.ts`
- Test: `tests/safety.test.ts`

**Interfaces:**
- Consumes: `flagEdSignal` from `lib/profile.ts` (Task 1); `ToolDefinition` from `lib/claude.ts`.
- Produces:
  - `export const FLAG_CONCERN_TOOL: ToolDefinition`
  - `export const SAFETY_GUARDRAILS_PROMPT: string`
  - `handleFlagConcernTool(rawInput: Record<string, unknown>): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/safety.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as profileLib from '../lib/profile.js';
import { handleFlagConcernTool } from '../lib/safety.js';

describe('handleFlagConcernTool', () => {
  it('flags the profile with the given reason and returns enforcement instructions', async () => {
    const flagSpy = vi.spyOn(profileLib, 'flagEdSignal').mockResolvedValue();

    const result = await handleFlagConcernTool({ reason: 'obsession répétée du chiffre calorique' });

    expect(flagSpy).toHaveBeenCalledWith('obsession répétée du chiffre calorique');
    expect(result).toContain('plus aucune cible chiffrée');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/safety.test.ts`
Expected: FAIL — `Cannot find module '../lib/safety.js'`.

- [ ] **Step 3: Create `lib/safety.ts`**

```ts
import { flagEdSignal } from './profile.js';
import type { ToolDefinition } from './claude.js';

export const FLAG_CONCERN_TOOL: ToolDefinition = {
  name: 'flag_concern',
  description:
    "Signale un motif de préoccupation lié au comportement alimentaire (restriction excessive, culpabilité alimentaire marquée, comportements compensatoires, obsession du chiffre). Une fois appelé, l'agent cesse de donner des cibles chiffrées de façon persistante. N'appelle cet outil que face à un signal réel et répété, jamais à la légère.",
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Description brève et factuelle du signal observé' },
    },
    required: ['reason'],
  },
};

export const SAFETY_GUARDRAILS_PROMPT = `

Garde-fous non négociables :
- Si le langage de l'utilisateur suggère une restriction excessive, une culpabilité alimentaire marquée, des comportements compensatoires ou une obsession du chiffre : appelle flag_concern, cesse de donner des cibles chiffrées, exprime ton inquiétude simplement, oriente vers un professionnel de santé. Ne diagnostique jamais.
- Aucun conseil médical : n'interprète pas de symptômes, ne recommande aucun complément au-delà des bases, ne donne aucun avis sur des médicaments. Oriente systématiquement vers un professionnel pour ces sujets.`;

export async function handleFlagConcernTool(rawInput: Record<string, unknown>): Promise<string> {
  const { reason } = rawInput as unknown as { reason: string };
  await flagEdSignal(reason);
  return "Signalement enregistré, de façon persistante. À partir de maintenant, n'annonce plus aucune cible chiffrée (calories, rythme, macros) : exprime ta préoccupation simplement, sans jugement, et oriente vers un professionnel de santé. Ne diagnostique rien.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/safety.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/safety.ts tests/safety.test.ts
git commit -m "feat: flag_concern tool and shared safety-guardrails prompt"
git push
```

---

### Task 3: Enforce the flag in `handleOnboardingTool`

**Files:**
- Modify: `lib/onboarding.ts`
- Modify: `tests/onboarding.test.ts`

- [ ] **Step 1: Update the failing test**

```ts
// tests/onboarding.test.ts — add this import
import * as profileLib from '../lib/profile.js';
```

```ts
// add beforeEach to the handleOnboardingTool describe block, defaulting the flag to false
describe('handleOnboardingTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(profileLib, 'isEdSignalFlagged').mockResolvedValue(false);
  });

  // ...existing two tests unchanged...

  it('refuses to give a numeric target when an ED signal was previously flagged', async () => {
    vi.spyOn(profileLib, 'isEdSignalFlagged').mockResolvedValue(true);
    const saveSpy = vi.spyOn(profileLib, 'saveOnboardingProfile').mockResolvedValue();

    const result = await handleOnboardingTool({ ...baseInput });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(result).not.toMatch(/\d/); // no numbers — no rate, no protein target, nothing quantified
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/onboarding.test.ts`
Expected: FAIL — `handleOnboardingTool` doesn't check the flag yet, so it still saves and returns numbers.

- [ ] **Step 3: Update `handleOnboardingTool` in `lib/onboarding.ts`**

```ts
// add this import at the top of lib/onboarding.ts
import { saveOnboardingProfile, isEdSignalFlagged } from './profile.js';
```

```ts
// replace the start of handleOnboardingTool
export async function handleOnboardingTool(rawInput: Record<string, unknown>): Promise<string> {
  if (await isEdSignalFlagged()) {
    return "Un signal de préoccupation a déjà été noté précédemment. N'annonce aucune cible chiffrée pour l'instant ; exprime ton inquiétude avec bienveillance et oriente vers un professionnel de santé.";
  }

  const input = rawInput as unknown as OnboardingInput;
  const decision = resolveOnboardingDecision(input);

  // ...rest unchanged...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/onboarding.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/onboarding.ts tests/onboarding.test.ts
git commit -m "feat: onboarding refuses numeric targets once an ED signal is flagged"
git push
```

---

### Task 4: Wire `flag_concern` and the safety prompt into the webhook

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

- [ ] **Step 1: Update the failing tests**

```ts
// tests/webhook.test.ts — add this import
import { FLAG_CONCERN_TOOL } from '../lib/safety.js';
```

```ts
// update the general-chat test's assertion (append FLAG_CONCERN_TOOL and the appended prompt text)
expect(converseWithToolSpy).toHaveBeenCalledWith(
  'full system prompt' + SAFETY_GUARDRAILS_PROMPT,
  [],
  'salut',
  [...scenariosLib.SCENARIO_TOOLS, SET_WEEKLY_SCHEDULE_TOOL, LOG_WEIGHT_TOOL, LOG_MEAL_TOOL, FLAG_CONCERN_TOOL],
  expect.any(Function)
);
```

```ts
// import SAFETY_GUARDRAILS_PROMPT alongside FLAG_CONCERN_TOOL for the assertion above
import { FLAG_CONCERN_TOOL, SAFETY_GUARDRAILS_PROMPT } from '../lib/safety.js';
```

```ts
// update the onboarding-routing test's assertion (prompt now has the safety text appended, tools array has two entries)
expect(converseWithToolSpy).toHaveBeenCalledWith(
  onboardingLib.ONBOARDING_SYSTEM_PROMPT + SAFETY_GUARDRAILS_PROMPT,
  [],
  '80kg',
  [onboardingLib.ONBOARDING_TOOL, FLAG_CONCERN_TOOL],
  expect.any(Function)
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the webhook doesn't offer `FLAG_CONCERN_TOOL` or append the safety prompt yet.

- [ ] **Step 3: Update `api/telegram/webhook.ts`**

```ts
// add this import alongside the existing lib/meals.js import
import { FLAG_CONCERN_TOOL, SAFETY_GUARDRAILS_PROMPT, handleFlagConcernTool } from '../../lib/safety.js';
```

```ts
// replace the tool lists and both dispatchers
const GENERAL_CHAT_TOOLS = [
  ...SCENARIO_TOOLS,
  SET_WEEKLY_SCHEDULE_TOOL,
  LOG_WEIGHT_TOOL,
  LOG_MEAL_TOOL,
  FLAG_CONCERN_TOOL,
];

async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}

async function handleOnboardingChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleOnboardingTool(input);
}
```

```ts
// update handleMessage to append the safety prompt and use the new onboarding tool list/dispatcher
async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(10);
  const onboardingDone = await isOnboardingBasicsComplete();

  const result = onboardingDone
    ? await converseWithTool(
        (await buildScenarioSystemPrompt(SYSTEM_PROMPT, todayIsoDate())) +
          (await weeklyScheduleSystemPromptAddition()) +
          SAFETY_GUARDRAILS_PROMPT,
        history,
        text,
        GENERAL_CHAT_TOOLS,
        handleGeneralChatTool
      )
    : await converseWithTool(
        ONBOARDING_SYSTEM_PROMPT + SAFETY_GUARDRAILS_PROMPT,
        history,
        text,
        [ONBOARDING_TOOL, FLAG_CONCERN_TOOL],
        handleOnboardingChatTool
      );

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
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
git commit -m "feat: wire ED-signal flagging and safety prompt into both conversation modes"
git push
```

---

## Self-Review

**Spec coverage:** §10 #4 (ED-signal detection + persistent no-auto-reset state) ✅ — detection via prompt + `flag_concern` tool, persistence via `Profile.edSignalFlagged` with no reset path anywhere in the codebase, enforcement via the code-level check in `handleOnboardingTool` (the one place that currently produces numeric targets). §10 #7 (no medical advice) ✅ — folded into `SAFETY_GUARDRAILS_PROMPT`, applied everywhere the general or onboarding prompt is used. This closes the two guardrails explicitly deferred in the step-4 and step-2 memory notes.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `FLAG_CONCERN_TOOL`'s `{ reason: string }` input matches exactly what `handleFlagConcernTool` (Task 2) destructures and what the Task 2 test asserts. `handleOnboardingChatTool`'s `(name, input) => Promise<string>` shape (Task 4) matches `ToolHandler` from `lib/claude.ts` exactly, replacing the old single-tool inline wrapper at that call site.
