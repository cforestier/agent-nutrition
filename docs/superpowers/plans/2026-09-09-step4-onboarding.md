# Étape 4 — Onboarding conversationnel (collecte, sans le calcul de cible calorique) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tool-use-driven onboarding conversation: Claude asks the questions from spec §4 one at a time in plain text, then calls a single tool once everything is confirmed. The tool runs the already-built deterministic guardrails (`shouldRefuseProgram`, `resolveGoal`, `proteinTargetRangeG`) and persists the profile — but does **not** set a calorie target, since that still needs the body-scan PDF (step 3, deferred until the real file arrives). The webhook routes each incoming message to onboarding mode or general-chat mode based on whether onboarding basics are already saved.

**Architecture:** `lib/claude.ts` gains a second entry point, `converseWithTool()`, a bounded manual tool-use loop (max 4 iterations) — kept separate from the existing tool-free `converse()` used for general chat. `lib/onboarding.ts` owns the tool schema, the system prompt, and the **pure** decision function (`resolveOnboardingDecision`) that calls into `/lib/calc`. `lib/profile.ts` owns the one Prisma-touching function (`saveOnboardingProfile`) and a read-only routing check (`isOnboardingBasicsComplete`) — kept in its own module specifically so tests can `vi.spyOn` it from outside, the same cross-module pattern already used for `lib/telegram.ts` and `lib/messages.ts`.

**Tech Stack:** `@anthropic-ai/sdk` tool use (manual loop, no beta Tool Runner — a handful of bounded iterations doesn't need it), Prisma/MongoDB, Vitest.

**Spec:** `docs/spec-agent-nutrition-v4.md` §4 (onboarding questions, target-rate constants, BMI refusal, protein range, horizon-lengthening), §10 (guardrails #1–#3 — floor is out of scope here since it needs the scan; BMI refusal and rate cap are in scope), §11 (`profile` fields), §12 (`/lib/claude.ts`, tool-use pattern).

## Global Constraints

- **No live-database test ever writes to the `Profile` collection.** `Profile` is a mono-user singleton (`findFirst`-or-`create`) — once the real bot has run onboarding for real, a test that calls the real `saveOnboardingProfile` against the shared Atlas cluster would overwrite the user's actual profile. `lib/profile.ts`'s Prisma calls are simple `findFirst`/`create`/`update` — the same pattern already proven safe via the live tests on `Profile.count()` (step 1) and the `Message` collection (step 4a) — so they're covered by code review, not a live test. Every test that exercises `handleOnboardingTool` mocks `saveOnboardingProfile` via `vi.spyOn` on the imported `lib/profile.js` module; none of them touch the real database.
- The onboarding tool computes rate/horizon/protein and runs the BMI refusal check; it never computes or saves a `currentTargetKcal` — that field stays unset until the body-scan step exists.
- Tool-use loop is capped at 4 iterations (`MAX_TOOL_ITERATIONS`) to avoid runaway back-and-forth if the model keeps calling tools; exceeding the cap returns a plain apology string, not an error.

---

## File Structure

```
/lib
  claude.ts       # add: ToolDefinition, ToolHandler, converseWithTool()
  onboarding.ts   # ONBOARDING_TOOL, ONBOARDING_SYSTEM_PROMPT, OnboardingInput,
                  # OnboardingDecision, resolveOnboardingDecision(), handleOnboardingTool()
  profile.ts      # saveOnboardingProfile(), isOnboardingBasicsComplete()
/api/telegram/webhook.ts   # modified: route to onboarding vs general chat
/prisma/schema.prisma       # extend Profile model
/tests
  claude.test.ts            # add converseWithTool tests
  onboarding.test.ts
  webhook.test.ts            # modified: cover the routing branch
```

---

### Task 1: `lib/claude.ts` — bounded tool-use loop

**Files:**
- Modify: `lib/claude.ts`
- Modify: `tests/claude.test.ts`

**Interfaces:**
- Produces:
  - `export interface ToolDefinition { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }`
  - `export type ToolHandler = (input: Record<string, unknown>) => Promise<string>`
  - `converseWithTool(systemPrompt: string, history: ChatMessage[], userText: string, tool: ToolDefinition, handleTool: ToolHandler): Promise<ConverseResult>`

- [ ] **Step 1: Add the failing tests**

```ts
// append to tests/claude.test.ts
import type { ToolDefinition } from '../lib/claude.js';

const { converseWithTool } = await import('../lib/claude.js');

describe('converseWithTool', () => {
  const tool: ToolDefinition = {
    name: 'test_tool',
    description: 'A test tool',
    input_schema: { type: 'object', properties: {} },
  };

  beforeEach(() => {
    createMock.mockReset();
  });

  it('executes the tool once and returns the final text response', async () => {
    createMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'test_tool', input: { foo: 'bar' } }],
        usage: { output_tokens: 3 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Terminé.' }],
        usage: { output_tokens: 4 },
      });

    const handleTool = vi.fn().mockResolvedValue('tool result text');

    const result = await converseWithTool('system', [], 'salut', tool, handleTool);

    expect(handleTool).toHaveBeenCalledWith({ foo: 'bar' });
    expect(result).toEqual({ text: 'Terminé.', outputTokens: 7 });
  });

  it('returns the model text directly when no tool is called', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Quel est ton poids actuel ?' }],
      usage: { output_tokens: 6 },
    });

    const handleTool = vi.fn();
    const result = await converseWithTool('system', [], 'je veux commencer', tool, handleTool);

    expect(handleTool).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'Quel est ton poids actuel ?', outputTokens: 6 });
  });

  it('stops after the iteration cap if the model keeps calling tools', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool_x', name: 'test_tool', input: {} }],
      usage: { output_tokens: 1 },
    });
    const handleTool = vi.fn().mockResolvedValue('ok');

    const result = await converseWithTool('system', [], 'salut', tool, handleTool);

    expect(result.text).toBe("Désolé, je n'ai pas réussi à traiter ta demande, réessaie.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — `converseWithTool` is not exported yet.

- [ ] **Step 3: Extend `lib/claude.ts`**

```ts
// append to lib/claude.ts
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

const MAX_TOOL_ITERATIONS = 4;

export async function converseWithTool(
  systemPrompt: string,
  history: ChatMessage[],
  userText: string,
  tool: ToolDefinition,
  handleTool: ToolHandler
): Promise<ConverseResult> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  let totalOutputTokens = 0;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: [tool],
      messages,
    });
    totalOutputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'refusal') {
      return { text: 'Désolé, je ne peux pas répondre à ça.', outputTokens: totalOutputTokens };
    }

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((block) => block.type === 'text');
      const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      return { text, outputTokens: totalOutputTokens };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { text: '', outputTokens: totalOutputTokens };
    }

    const resultContent = await handleTool(toolUseBlock.input as Record<string, unknown>);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: resultContent }],
    });
  }

  return { text: "Désolé, je n'ai pas réussi à traiter ta demande, réessaie.", outputTokens: totalOutputTokens };
}
```

Also add the missing import at the top of `lib/claude.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/claude.test.ts`
Expected: PASS (5 tests total — 2 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add lib/claude.ts tests/claude.test.ts
git commit -m "feat(claude): bounded tool-use loop (converseWithTool)"
```

---

### Task 2: `lib/profile.ts` — Prisma-backed profile persistence

**Files:**
- Modify: `prisma/schema.prisma` (extend `Profile`)
- Create: `lib/profile.ts`

**Interfaces:**
- Consumes: `OnboardingInput`, `OnboardingDecision` from `lib/onboarding.ts` (Task 3 — declared as a forward type reference; Task 3 imports `saveOnboardingProfile` from here, so define the shape inline in this file rather than importing from `onboarding.ts`, to avoid a circular import).
- Produces:
  - `saveOnboardingProfile(input: OnboardingProfileInput, decision: AcceptedOnboardingDecision): Promise<void>`
  - `isOnboardingBasicsComplete(): Promise<boolean>`

- [ ] **Step 1: Extend the `Profile` model**

```prisma
// replace the existing Profile model in prisma/schema.prisma
model Profile {
  id                       String    @id @default(auto()) @map("_id") @db.ObjectId
  startDate                DateTime?
  weightKg                 Float?
  heightCm                 Float?
  age                      Int?
  sex                      String?
  targetWeightKg            Float?
  targetWeeks              Int?
  ratePctPerWeek           Float?
  constraints              String[]
  weighInDay               String?
  reviewDay                String?
  restDayPresent           Boolean?
  onboardingBasicsComplete Boolean   @default(false)
  onboardingComplete       Boolean   @default(false)
  createdAt                DateTime  @default(now())
  updatedAt                DateTime  @updatedAt
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Create `lib/profile.ts`** (no test file — see Global Constraints: reviewed by hand, never live-tested against the real singleton)

```ts
import { prisma } from './db.js';

export interface OnboardingProfileInput {
  startDate: string;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
  targetWeightKg: number;
  constraints: string[];
  weighInDay: string;
  reviewDay: string;
  restDayPresent: boolean;
}

export interface AcceptedOnboardingDecision {
  refused: false;
  ratePctPerWeek: number;
  weeks: number;
}

export async function saveOnboardingProfile(
  input: OnboardingProfileInput,
  decision: AcceptedOnboardingDecision
): Promise<void> {
  const data = {
    startDate: new Date(input.startDate),
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    age: input.age,
    sex: input.sex,
    targetWeightKg: input.targetWeightKg,
    targetWeeks: decision.weeks,
    ratePctPerWeek: decision.ratePctPerWeek,
    constraints: input.constraints,
    weighInDay: input.weighInDay,
    reviewDay: input.reviewDay,
    restDayPresent: input.restDayPresent,
    onboardingBasicsComplete: true,
  };

  const existing = await prisma.profile.findFirst();
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}

export async function isOnboardingBasicsComplete(): Promise<boolean> {
  const profile = await prisma.profile.findFirst();
  return profile?.onboardingBasicsComplete ?? false;
}
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma lib/profile.ts
git commit -m "feat: profile persistence for onboarding (extended Profile model)"
```

---

### Task 3: `lib/onboarding.ts` — tool schema, system prompt, decision logic

**Files:**
- Create: `lib/onboarding.ts`
- Test: `tests/onboarding.test.ts`

**Interfaces:**
- Consumes: `shouldRefuseProgram` from `lib/calc/guardrails.ts`; `resolveGoal`, `proteinTargetRangeG` from `lib/calc/baseline.ts`; `ToolDefinition` from `lib/claude.ts` (Task 1); `saveOnboardingProfile` from `lib/profile.ts` (Task 2).
- Produces:
  - `export const ONBOARDING_TOOL: ToolDefinition`
  - `export const ONBOARDING_SYSTEM_PROMPT: string`
  - `export interface OnboardingInput { startDate: string; weightKg: number; heightCm: number; age: number; sex: 'male' | 'female'; targetWeightKg: number; targetWeeks: number; constraints: string[]; weighInDay: string; reviewDay: string; restDayPresent: boolean }`
  - `export type OnboardingDecision = { refused: true } | { refused: false; ratePctPerWeek: number; weeks: number; adjusted: boolean; proteinMinG: number; proteinMaxG: number }`
  - `resolveOnboardingDecision(input: OnboardingInput): OnboardingDecision`
  - `handleOnboardingTool(rawInput: Record<string, unknown>): Promise<string>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/onboarding.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as profileLib from '../lib/profile.js';
import {
  resolveOnboardingDecision,
  handleOnboardingTool,
} from '../lib/onboarding.js';
import type { OnboardingInput } from '../lib/onboarding.js';

const baseInput: OnboardingInput = {
  startDate: '2026-09-10',
  weightKg: 80,
  heightCm: 180,
  age: 30,
  sex: 'male',
  targetWeightKg: 74,
  targetWeeks: 12,
  constraints: [],
  weighInDay: 'monday',
  reviewDay: 'sunday',
  restDayPresent: true,
};

describe('resolveOnboardingDecision', () => {
  it('refuses when BMI would go below the floor', () => {
    const decision = resolveOnboardingDecision({ ...baseInput, weightKg: 50, heightCm: 175, targetWeightKg: 48 });
    expect(decision).toEqual({ refused: true });
  });

  it('accepts the requested rate when under the cap', () => {
    const decision = resolveOnboardingDecision(baseInput);
    expect(decision.refused).toBe(false);
    if (!decision.refused) {
      expect(decision.adjusted).toBe(false);
      expect(decision.weeks).toBe(12);
      expect(decision.proteinMinG).toBeCloseTo(160, 5);
      expect(decision.proteinMaxG).toBeCloseTo(176, 5);
    }
  });

  it('lengthens the horizon when the requested rate exceeds the cap', () => {
    const decision = resolveOnboardingDecision({ ...baseInput, targetWeightKg: 70, targetWeeks: 8 });
    expect(decision.refused).toBe(false);
    if (!decision.refused) {
      expect(decision.adjusted).toBe(true);
      expect(decision.weeks).toBe(17);
    }
  });
});

describe('handleOnboardingTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('saves the profile and returns a confirmation message when accepted', async () => {
    const saveSpy = vi.spyOn(profileLib, 'saveOnboardingProfile').mockResolvedValue();

    const result = await handleOnboardingTool({ ...baseInput });

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ weightKg: 80, targetWeightKg: 74 }),
      expect.objectContaining({ refused: false, weeks: 12 })
    );
    expect(result).toContain('Profil enregistré');
    expect(result).toContain('scan de composition corporelle');
  });

  it('does not save anything and returns a refusal message when BMI is below the floor', async () => {
    const saveSpy = vi.spyOn(profileLib, 'saveOnboardingProfile').mockResolvedValue();

    const result = await handleOnboardingTool({ ...baseInput, weightKg: 50, heightCm: 175, targetWeightKg: 48 });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(result).toContain('REFUS');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/onboarding.test.ts`
Expected: FAIL — `Cannot find module '../lib/onboarding.js'`.

- [ ] **Step 3: Create `lib/onboarding.ts`**

```ts
import { shouldRefuseProgram } from './calc/guardrails.js';
import { resolveGoal, proteinTargetRangeG } from './calc/baseline.js';
import { saveOnboardingProfile } from './profile.js';
import type { ToolDefinition } from './claude.js';

export const ONBOARDING_TOOL: ToolDefinition = {
  name: 'record_onboarding_profile',
  description:
    "Enregistre le profil d'onboarding une fois que tous les champs ont été confirmés avec l'utilisateur. À appeler une seule fois, à la fin de la conversation d'onboarding.",
  input_schema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Date de démarrage, format YYYY-MM-DD' },
      weightKg: { type: 'number' },
      heightCm: { type: 'number' },
      age: { type: 'integer' },
      sex: { type: 'string', enum: ['male', 'female'] },
      targetWeightKg: { type: 'number' },
      targetWeeks: { type: 'integer' },
      constraints: { type: 'array', items: { type: 'string' } },
      weighInDay: { type: 'string' },
      reviewDay: { type: 'string' },
      restDayPresent: { type: 'boolean' },
    },
    required: [
      'startDate',
      'weightKg',
      'heightCm',
      'age',
      'sex',
      'targetWeightKg',
      'targetWeeks',
      'constraints',
      'weighInDay',
      'reviewDay',
      'restDayPresent',
    ],
  },
};

export const ONBOARDING_SYSTEM_PROMPT = `Tu mènes la conversation d'onboarding de Raphaël, athlète d'endurance en volume élevé (8-10h/semaine).
Pose les questions une par une, en langage naturel, jusqu'à avoir : date de démarrage, poids actuel, taille, âge, sexe, poids cible, horizon souhaité en semaines, contraintes/aversions alimentaires, jour de pesée hebdo, jour du bilan, présence d'un jour de repos complet.
Une fois TOUS ces éléments confirmés avec l'utilisateur, appelle l'outil record_onboarding_profile UNE SEULE FOIS avec toutes les valeurs.
Ne calcule jamais toi-même de cible calorique ou de rythme de perte — c'est l'outil qui s'en charge.
Si l'outil retourne un refus, explique-le simplement, sans jugement, et oriente vers un professionnel de santé. N'insiste pas et ne propose aucune cible chiffrée dans ce cas.
Ton factuel, jamais moralisateur.`;

export interface OnboardingInput {
  startDate: string;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
  targetWeightKg: number;
  targetWeeks: number;
  constraints: string[];
  weighInDay: string;
  reviewDay: string;
  restDayPresent: boolean;
}

export type OnboardingDecision =
  | { refused: true }
  | {
      refused: false;
      ratePctPerWeek: number;
      weeks: number;
      adjusted: boolean;
      proteinMinG: number;
      proteinMaxG: number;
    };

export function resolveOnboardingDecision(input: OnboardingInput): OnboardingDecision {
  if (shouldRefuseProgram(input.weightKg, input.targetWeightKg, input.heightCm)) {
    return { refused: true };
  }

  const goal = resolveGoal({
    currentWeightKg: input.weightKg,
    targetWeightKg: input.targetWeightKg,
    requestedWeeks: input.targetWeeks,
  });
  const protein = proteinTargetRangeG(input.weightKg);

  return {
    refused: false,
    ratePctPerWeek: goal.ratePctPerWeek,
    weeks: goal.weeks,
    adjusted: goal.adjusted,
    proteinMinG: protein.minG,
    proteinMaxG: protein.maxG,
  };
}

export async function handleOnboardingTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as OnboardingInput;
  const decision = resolveOnboardingDecision(input);

  if (decision.refused) {
    return "REFUS : l'IMC actuel ou l'IMC cible est sous le seuil de sécurité (18.5). N'annonce aucune cible chiffrée, oriente vers un professionnel de santé, avec bienveillance.";
  }

  await saveOnboardingProfile(input, decision);

  const horizonNote = decision.adjusted
    ? `L'horizon a été allongé à ${decision.weeks} semaines pour rester sous le rythme de perte maximal (0.75%/semaine) — le déficit n'a pas été creusé.`
    : `Rythme et horizon demandés acceptés tels quels (${decision.weeks} semaines).`;

  return [
    'Profil enregistré avec succès.',
    horizonNote,
    `Rythme cible retenu : ${decision.ratePctPerWeek.toFixed(2)}% du poids/semaine.`,
    `Cible protéines : ${decision.proteinMinG.toFixed(0)}-${decision.proteinMaxG.toFixed(0)} g/jour.`,
    "Aucune cible calorique n'est fixée pour l'instant : il manque le scan de composition corporelle (prérequis bloquant). Dis à l'utilisateur d'envoyer la photo/PDF du scan dès qu'il l'aura.",
  ].join(' ');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/onboarding.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/onboarding.ts tests/onboarding.test.ts
git commit -m "feat: onboarding tool schema, prompt, and decision logic"
```

---

### Task 4: Wire the webhook to route onboarding vs general chat

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `converse`, `converseWithTool` from `lib/claude.ts`; `ONBOARDING_SYSTEM_PROMPT`, `ONBOARDING_TOOL`, `handleOnboardingTool` from `lib/onboarding.ts`; `isOnboardingBasicsComplete` from `lib/profile.ts`; `SYSTEM_PROMPT` from `lib/prompts.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/webhook.test.ts, alongside the existing imports
import * as profileLib from '../lib/profile.js';
import * as onboardingLib from '../lib/onboarding.js';
```

```ts
// add this test inside the existing describe block
it('routes to the onboarding tool flow when onboarding basics are not yet saved', async () => {
  vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(false);
  vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
  const converseWithToolSpy = vi
    .spyOn(claudeLib, 'converseWithTool')
    .mockResolvedValue({ text: 'Quel est ton poids ?', outputTokens: 4 });
  const converseSpy = vi.spyOn(claudeLib, 'converse');
  vi.spyOn(messagesLib, 'saveMessage').mockResolvedValue();
  const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
  const res = mockRes();
  const body = { message: { chat: { id: 12345 }, text: '80kg' } };

  await handler({ method: 'POST', body } as any, res as any);
  await flushBackgroundTasks();

  expect(converseWithToolSpy).toHaveBeenCalledWith(
    onboardingLib.ONBOARDING_SYSTEM_PROMPT,
    [],
    '80kg',
    onboardingLib.ONBOARDING_TOOL,
    onboardingLib.handleOnboardingTool
  );
  expect(converseSpy).not.toHaveBeenCalled();
  expect(sendSpy).toHaveBeenCalledWith(12345, 'Quel est ton poids ?');
});
```

Also update the existing "replies with Claude's answer" test to mock `isOnboardingBasicsComplete` as `true` (so it still exercises the general-chat branch):

```ts
// inside the existing "responds 200 and replies with Claude's answer..." test, before calling handler:
vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(true);
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — `handleMessage` always calls `converse`, never checks onboarding status.

- [ ] **Step 3: Update `api/telegram/webhook.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';
import { converse, converseWithTool } from '../../lib/claude.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';
import { isOnboardingBasicsComplete } from '../../lib/profile.js';
import { ONBOARDING_SYSTEM_PROMPT, ONBOARDING_TOOL, handleOnboardingTool } from '../../lib/onboarding.js';

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
  const onboardingDone = await isOnboardingBasicsComplete();

  const result = onboardingDone
    ? await converse(SYSTEM_PROMPT, [...history, { role: 'user', content: text }])
    : await converseWithTool(ONBOARDING_SYSTEM_PROMPT, history, text, ONBOARDING_TOOL, handleOnboardingTool);

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: route webhook to onboarding tool flow until basics are saved"
```

---

## Self-Review

**Spec coverage (§4 onboarding):** all listed questions map to `OnboardingInput` fields ✅. Target-rate constants (`RATE_MAX_PCT`, horizon-lengthening) ✅ — reused from `/lib/calc/baseline.ts`, not reimplemented. BMI refusal (§10 #3) ✅. Protein range (§4) ✅. Kcal floor (§10 #1) explicitly **not** computed here — correctly deferred, documented in Global Constraints and in the tool's own reply text so the user isn't told a number that doesn't exist yet.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `ToolDefinition` (Task 1) is the exact shape `ONBOARDING_TOOL` is declared as (Task 3). `OnboardingDecision`'s accepted variant (`{ refused: false; ratePctPerWeek; weeks; adjusted; proteinMinG; proteinMaxG }`, Task 3) matches the narrower `AcceptedOnboardingDecision` (`{ refused: false; ratePctPerWeek; weeks }`, Task 2) structurally — `saveOnboardingProfile` only reads the two fields it needs, so the wider type from Task 3 is assignable without a cast. `converseWithTool`'s signature (Task 1) matches its call site in Task 4 exactly (`ONBOARDING_SYSTEM_PROMPT, history, text, ONBOARDING_TOOL, handleOnboardingTool`).
