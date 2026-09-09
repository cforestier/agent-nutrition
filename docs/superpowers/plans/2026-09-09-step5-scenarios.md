# Étape 5 — Scénarios (résolution en langage naturel) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed weekly schedule with the spec's named-scenarios system: once onboarding is done, every message can describe the day in natural language ("CrossFit en vélo, et je dors chez Rémi"), and Claude resolves it against known scenarios via tool use — creating new scenarios on the fly when it meets an unfamiliar phrasing, and pre-filling the next day automatically when a scenario implies one.

**Architecture:** `converseWithTool()` in `lib/claude.ts` is generalized from a single tool to a tool **list** plus a name-dispatching handler — the onboarding flow (Task 4 of the previous plan) already needed exactly one tool, but scenarios need two (`create_scenario`, `apply_day_plan`), so the signature is widened once, here, rather than duplicating the loop. `lib/scenarios.ts` owns both tool schemas, the matching/persistence logic (`Scenario`/`DayPlan` Mongo collections), and the dispatcher. The webhook's "onboarding done" branch switches from plain `converse()` to `converseWithTool()` with the scenario toolset and a system prompt that's rebuilt every message to include the current date and the list of known scenarios (per spec §13: "scénarios connus, toujours inclus").

**Tech Stack:** Same as steps 4/4a — `@anthropic-ai/sdk` manual tool-use loop, Prisma/MongoDB, Vitest with `vi.spyOn` mocking (no live Claude calls in tests; `Scenario`/`DayPlan` are safe to live-test since, unlike `Profile`, they're accumulating collections, not a singleton).

**Spec:** `docs/spec-agent-nutrition-v4.md` §3 (scenarios — table shapes, resolution behavior, learning, `implies_next_day`), §13 (context: "scénarios connus" always included).

## Global Constraints

- `converseWithTool`'s tool handler is now `(toolName: string, input: Record<string, unknown>) => Promise<string>` — every call site (onboarding included) is updated in the same task that changes the signature, so nothing is left broken mid-plan.
- Scenario matching is case-insensitive against a scenario's `name` or any of its `aliases` — the model calls tools with whatever exact wording it used in `aliases`, not a database key it has to remember.
- `DayPlan.date` is the natural key (`YYYY-MM-DD`, unique) — `apply_day_plan` upserts by date so re-confirming the same day overwrites rather than duplicating.
- The **implied next-day pre-fill is unconfirmed** (`confirmed: false`) — it's a prediction, not something the user has actually stated for that day yet; only a real `apply_day_plan` call for that date sets `confirmed: true`.
- No live-database test ever touches the `Profile` collection (carried over from the previous plan). `Scenario` and `DayPlan` tests use a unique-per-run name/date so repeated test runs never collide with each other or (once the bot is live) with real data — same style as `tests/messages.test.ts`.

---

## File Structure

```
/lib
  claude.ts       # modify: converseWithTool takes tools[] + (name, input) handler
  scenarios.ts    # CREATE_SCENARIO_TOOL, APPLY_DAY_PLAN_TOOL, SCENARIO_TOOLS,
                  # saveScenario(), applyDayPlan(), buildScenarioSystemPrompt(), handleScenarioTool()
/api/telegram/webhook.ts   # modified: onboarding-done branch uses converseWithTool + scenario tools
/prisma/schema.prisma       # add Scenario, DayPlan models
/tests
  claude.test.ts             # modified: multi-tool signature
  scenarios.test.ts
  webhook.test.ts            # modified: both branches now use converseWithTool
```

---

### Task 1: Prisma schema — `Scenario` and `DayPlan`

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the two models**

```prisma
model Scenario {
  id                       String   @id @default(auto()) @map("_id") @db.ObjectId
  name                     String
  aliases                  String[]
  segments                 Json
  impliesNextDayScenarioId String?
  usageCount               Int      @default(0)
  createdAt                DateTime @default(now())
}

model DayPlan {
  id               String   @id @default(auto()) @map("_id") @db.ObjectId
  date             String   @unique
  scenariosApplied String[]
  segmentsResolved Json
  confirmed        Boolean  @default(false)
  isAtypical       Boolean  @default(false)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" success message.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add Scenario and DayPlan models"
```

---

### Task 2: Generalize `converseWithTool` to a tool list

**Files:**
- Modify: `lib/claude.ts`
- Modify: `tests/claude.test.ts`

**Interfaces:**
- Produces (replacing the Task 1-of-step-4 signature):
  - `export type ToolHandler = (toolName: string, input: Record<string, unknown>) => Promise<string>`
  - `converseWithTool(systemPrompt: string, history: ChatMessage[], userText: string, tools: ToolDefinition[], handleTool: ToolHandler): Promise<ConverseResult>`

- [ ] **Step 1: Update the failing tests**

```ts
// tests/claude.test.ts — replace the whole `describe('converseWithTool', ...)` block
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

    const result = await converseWithTool('system', [], 'salut', [tool], handleTool);

    expect(handleTool).toHaveBeenCalledWith('test_tool', { foo: 'bar' });
    expect(result).toEqual({ text: 'Terminé.', outputTokens: 7 });
  });

  it('returns the model text directly when no tool is called', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Quel est ton poids actuel ?' }],
      usage: { output_tokens: 6 },
    });

    const handleTool = vi.fn();
    const result = await converseWithTool('system', [], 'je veux commencer', [tool], handleTool);

    expect(handleTool).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'Quel est ton poids actuel ?', outputTokens: 6 });
  });

  it('dispatches to the correct tool by name when multiple tools are offered', async () => {
    createMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_2', name: 'second_tool', input: { x: 1 } }],
        usage: { output_tokens: 2 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { output_tokens: 1 },
      });

    const secondTool: ToolDefinition = { name: 'second_tool', description: '', input_schema: { type: 'object', properties: {} } };
    const handleTool = vi.fn().mockResolvedValue('handled');

    await converseWithTool('system', [], 'salut', [tool, secondTool], handleTool);

    expect(handleTool).toHaveBeenCalledWith('second_tool', { x: 1 });
  });

  it('stops after the iteration cap if the model keeps calling tools', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool_x', name: 'test_tool', input: {} }],
      usage: { output_tokens: 1 },
    });
    const handleTool = vi.fn().mockResolvedValue('ok');

    const result = await converseWithTool('system', [], 'salut', [tool], handleTool);

    expect(result.text).toBe("Désolé, je n'ai pas réussi à traiter ta demande, réessaie.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — current `converseWithTool` takes a single `tool` and a single-arg handler.

- [ ] **Step 3: Update `converseWithTool` in `lib/claude.ts`**

```ts
// replace the ToolHandler type and converseWithTool function
export type ToolHandler = (toolName: string, input: Record<string, unknown>) => Promise<string>;

export async function converseWithTool(
  systemPrompt: string,
  history: ChatMessage[],
  userText: string,
  tools: ToolDefinition[],
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
      tools,
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

    const resultContent = await handleTool(toolUseBlock.name, toolUseBlock.input as Record<string, unknown>);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: resultContent }],
    });
  }

  return { text: "Désolé, je n'ai pas réussi à traiter ta demande, réessaie.", outputTokens: totalOutputTokens };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/claude.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/claude.ts tests/claude.test.ts
git commit -m "feat(claude): converseWithTool accepts multiple tools, dispatches by name"
```

---

### Task 3: `lib/scenarios.ts` — tools, matching, persistence

**Files:**
- Create: `lib/scenarios.ts`
- Test: `tests/scenarios.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` from `lib/claude.ts` (Task 2).
- Produces:
  - `export interface Segment { type: string; durationMin: number; intensity: string; timing: string }`
  - `export const CREATE_SCENARIO_TOOL: ToolDefinition`
  - `export const APPLY_DAY_PLAN_TOOL: ToolDefinition`
  - `export const SCENARIO_TOOLS: ToolDefinition[]`
  - `saveScenario(input: CreateScenarioInput): Promise<void>`
  - `applyDayPlan(input: ApplyDayPlanInput): Promise<{ resolved: boolean; unknownNames: string[] }>`
  - `buildScenarioSystemPrompt(basePrompt: string, todayIso: string): Promise<string>`
  - `handleScenarioTool(name: string, input: Record<string, unknown>): Promise<string>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scenarios.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveScenario, applyDayPlan, buildScenarioSystemPrompt, handleScenarioTool } from '../lib/scenarios.js';

describe('scenarios', () => {
  const marker = `test-${Date.now()}`;
  const scenarioName = `${marker}-crossfit-velo`;
  const impliedName = `${marker}-dort-chez-remi`;
  const day1 = '2026-11-02';
  const day2 = '2026-11-03';

  afterAll(async () => {
    await prisma.scenario.deleteMany({ where: { name: { contains: marker } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: [day1, day2] } } });
  });

  it('creates a scenario, matches it case-insensitively, and applies it to a day plan', async () => {
    await saveScenario({
      name: impliedName,
      aliases: [`je dors chez rémi`],
      segments: [{ type: 'vélo', durationMin: 15, intensity: 'léger', timing: 'matin' }],
    });

    await saveScenario({
      name: scenarioName,
      aliases: [`crossfit en vélo (${marker})`],
      segments: [{ type: 'crossfit', durationMin: 45, intensity: 'haute', timing: 'matin' }],
      impliesNextDayScenarioName: impliedName,
    });

    const result = await applyDayPlan({
      date: day1,
      scenarioNames: [scenarioName.toUpperCase()],
      isAtypical: false,
    });

    expect(result).toEqual({ resolved: true, unknownNames: [] });

    const savedPlan = await prisma.dayPlan.findUnique({ where: { date: day1 } });
    expect(savedPlan?.confirmed).toBe(true);
    expect(savedPlan?.segmentsResolved).toEqual([
      { type: 'crossfit', durationMin: 45, intensity: 'haute', timing: 'matin' },
    ]);

    const nextDayPlan = await prisma.dayPlan.findUnique({ where: { date: day2 } });
    expect(nextDayPlan?.confirmed).toBe(false);
    expect(nextDayPlan?.scenariosApplied).toHaveLength(1);
  });

  it('reports unknown scenario names without saving anything', async () => {
    const result = await applyDayPlan({ date: '1999-01-01', scenarioNames: [`${marker}-nope`], isAtypical: false });
    expect(result).toEqual({ resolved: false, unknownNames: [`${marker}-nope`] });
    const plan = await prisma.dayPlan.findUnique({ where: { date: '1999-01-01' } });
    expect(plan).toBeNull();
  });

  it('includes known scenarios in the built system prompt', async () => {
    const prompt = await buildScenarioSystemPrompt('BASE', '2026-11-02');
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('2026-11-02');
    expect(prompt).toContain(scenarioName);
  });

  it('handleScenarioTool dispatches create_scenario and apply_day_plan by name', async () => {
    const createMsg = await handleScenarioTool('create_scenario', {
      name: `${marker}-standalone`,
      aliases: ['x'],
      segments: [{ type: 'vélo', durationMin: 10, intensity: 'léger', timing: 'soir' }],
    });
    expect(createMsg).toContain('créé');

    const applyMsg = await handleScenarioTool('apply_day_plan', {
      date: '2026-11-04',
      scenarioNames: [`${marker}-standalone`],
      isAtypical: true,
    });
    expect(applyMsg).toContain('2026-11-04');
    await prisma.dayPlan.deleteMany({ where: { date: '2026-11-04' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scenarios.test.ts`
Expected: FAIL — `Cannot find module '../lib/scenarios.js'`.

- [ ] **Step 3: Create `lib/scenarios.ts`**

```ts
import { prisma } from './db.js';
import type { ToolDefinition } from './claude.js';

export interface Segment {
  type: string;
  durationMin: number;
  intensity: string;
  timing: string;
}

export const CREATE_SCENARIO_TOOL: ToolDefinition = {
  name: 'create_scenario',
  description:
    "Crée un nouveau scénario nommé quand l'utilisateur emploie une formulation inconnue et vient d'en préciser le sens. Ne l'appelle qu'après avoir confirmé les détails avec l'utilisateur.",
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      segments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            durationMin: { type: 'number' },
            intensity: { type: 'string' },
            timing: { type: 'string' },
          },
          required: ['type', 'durationMin', 'intensity', 'timing'],
        },
      },
      impliesNextDayScenarioName: { type: 'string' },
    },
    required: ['name', 'aliases', 'segments'],
  },
};

export const APPLY_DAY_PLAN_TOOL: ToolDefinition = {
  name: 'apply_day_plan',
  description:
    "Enregistre le plan du jour (et pré-configure le lendemain si un scénario l'implique) une fois les scénarios du jour identifiés dans le message de l'utilisateur.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      scenarioNames: { type: 'array', items: { type: 'string' } },
      isAtypical: { type: 'boolean' },
    },
    required: ['date', 'scenarioNames', 'isAtypical'],
  },
};

export const SCENARIO_TOOLS: ToolDefinition[] = [CREATE_SCENARIO_TOOL, APPLY_DAY_PLAN_TOOL];

export interface CreateScenarioInput {
  name: string;
  aliases: string[];
  segments: Segment[];
  impliesNextDayScenarioName?: string;
}

async function findScenarioByNameOrAlias(nameOrAlias: string) {
  const needle = nameOrAlias.trim().toLowerCase();
  const scenarios = await prisma.scenario.findMany();
  return scenarios.find(
    (s) => s.name.toLowerCase() === needle || s.aliases.some((a) => a.toLowerCase() === needle)
  );
}

export async function saveScenario(input: CreateScenarioInput): Promise<void> {
  let impliesNextDayScenarioId: string | undefined;
  if (input.impliesNextDayScenarioName) {
    const implied = await findScenarioByNameOrAlias(input.impliesNextDayScenarioName);
    impliesNextDayScenarioId = implied?.id;
  }

  await prisma.scenario.create({
    data: {
      name: input.name,
      aliases: input.aliases,
      segments: input.segments,
      impliesNextDayScenarioId,
      usageCount: 0,
    },
  });
}

export interface ApplyDayPlanInput {
  date: string;
  scenarioNames: string[];
  isAtypical: boolean;
}

function addOneDay(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function applyDayPlan(
  input: ApplyDayPlanInput
): Promise<{ resolved: boolean; unknownNames: string[] }> {
  const matches = await Promise.all(input.scenarioNames.map((n) => findScenarioByNameOrAlias(n)));
  const unknownNames = input.scenarioNames.filter((_, i) => !matches[i]);
  const found = matches.filter((m): m is NonNullable<typeof m> => m !== undefined);

  if (found.length === 0) {
    return { resolved: false, unknownNames };
  }

  const segmentsResolved = found.flatMap((s) => s.segments as unknown as Segment[]);

  await prisma.dayPlan.upsert({
    where: { date: input.date },
    create: {
      date: input.date,
      scenariosApplied: found.map((s) => s.id),
      segmentsResolved,
      confirmed: true,
      isAtypical: input.isAtypical,
    },
    update: {
      scenariosApplied: found.map((s) => s.id),
      segmentsResolved,
      confirmed: true,
      isAtypical: input.isAtypical,
    },
  });

  await Promise.all(
    found.map((s) => prisma.scenario.update({ where: { id: s.id }, data: { usageCount: { increment: 1 } } }))
  );

  const impliedScenarioId = found.find((s) => s.impliesNextDayScenarioId)?.impliesNextDayScenarioId;
  if (impliedScenarioId) {
    const implied = await prisma.scenario.findUnique({ where: { id: impliedScenarioId } });
    if (implied) {
      const nextDate = addOneDay(input.date);
      await prisma.dayPlan.upsert({
        where: { date: nextDate },
        create: {
          date: nextDate,
          scenariosApplied: [implied.id],
          segmentsResolved: implied.segments as unknown as Segment[],
          confirmed: false,
          isAtypical: false,
        },
        update: {},
      });
    }
  }

  return { resolved: true, unknownNames };
}

export async function buildScenarioSystemPrompt(basePrompt: string, todayIso: string): Promise<string> {
  const scenarios = await prisma.scenario.findMany();
  const list = scenarios.length
    ? scenarios.map((s) => `- ${s.name} (alias : ${s.aliases.join(', ') || 'aucun'})`).join('\n')
    : "(aucun scénario connu pour l'instant)";

  return `${basePrompt}

Date du jour : ${todayIso}.
Scénarios connus :
${list}

Quand l'utilisateur décrit sa journée (trajets, entraînement, où il dort...), résous les scénarios qui s'appliquent et appelle apply_day_plan avec leurs noms exacts et la date du jour.
Si une formulation ne correspond à aucun scénario connu, demande d'abord ce qu'elle implique en langage naturel ; une fois la réponse obtenue, appelle create_scenario, puis apply_day_plan si pertinent.
N'appelle jamais ces outils sans avoir d'abord confirmé le sens avec l'utilisateur si le moindre doute existe.`;
}

export async function handleScenarioTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'create_scenario') {
    const parsed = input as unknown as CreateScenarioInput;
    await saveScenario(parsed);
    return `Scénario "${parsed.name}" créé et mémorisé pour la prochaine fois.`;
  }

  if (name === 'apply_day_plan') {
    const parsed = input as unknown as ApplyDayPlanInput;
    const result = await applyDayPlan(parsed);
    if (!result.resolved) {
      return `Aucun des scénarios cités (${parsed.scenarioNames.join(', ')}) n'est connu. Demande à l'utilisateur de préciser, puis crée le scénario si besoin.`;
    }
    const note = result.unknownNames.length ? ` (non reconnus, ignorés : ${result.unknownNames.join(', ')})` : '';
    return `Plan du ${parsed.date} enregistré${note}.`;
  }

  return `Outil inconnu : ${name}.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scenarios.test.ts`
Expected: PASS (4 tests) — live against the real Atlas cluster, cleaned up via `afterAll`.

- [ ] **Step 5: Commit**

```bash
git add lib/scenarios.ts tests/scenarios.test.ts
git commit -m "feat: scenario tools, matching, and day-plan persistence"
```

---

### Task 4: Wire the webhook to the scenario toolset

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `converseWithTool` (Task 2, new signature); `SCENARIO_TOOLS`, `handleScenarioTool`, `buildScenarioSystemPrompt` from `lib/scenarios.ts` (Task 3); `ONBOARDING_TOOL`, `handleOnboardingTool` from `lib/onboarding.ts` (now wrapped to match the `(name, input)` handler shape).

- [ ] **Step 1: Update the failing tests**

```ts
// tests/webhook.test.ts — add this import alongside the existing ones
import * as scenariosLib from '../lib/scenarios.js';
```

```ts
// replace the "responds 200 and replies with Claude's answer..." test
it("responds 200 and replies with Claude's answer from the allowed chat", async () => {
  vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(true);
  vi.spyOn(scenariosLib, 'buildScenarioSystemPrompt').mockResolvedValue('full system prompt');
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
    scenariosLib.SCENARIO_TOOLS,
    scenariosLib.handleScenarioTool
  );
  expect(saveSpy).toHaveBeenCalledWith('user', 'salut');
  expect(saveSpy).toHaveBeenCalledWith('assistant', 'Bonjour !', 5);
  expect(sendSpy).toHaveBeenCalledWith(12345, 'Bonjour !');
});
```

```ts
// update the onboarding-routing test's assertion — the handler is now a wrapper,
// not a reference to handleOnboardingTool itself
it('routes to the onboarding tool flow when onboarding basics are not yet saved', async () => {
  vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(false);
  vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
  const converseWithToolSpy = vi
    .spyOn(claudeLib, 'converseWithTool')
    .mockResolvedValue({ text: 'Quel est ton poids ?', outputTokens: 4 });
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
    [onboardingLib.ONBOARDING_TOOL],
    expect.any(Function)
  );
  expect(sendSpy).toHaveBeenCalledWith(12345, 'Quel est ton poids ?');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — `handleMessage` still calls plain `converse()` for the onboarding-done branch and passes the old single-tool shape for onboarding.

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
    ? await converseWithTool(
        await buildScenarioSystemPrompt(SYSTEM_PROMPT, todayIsoDate()),
        history,
        text,
        SCENARIO_TOOLS,
        handleScenarioTool
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
git commit -m "feat: route general chat through the scenario toolset"
```

---

## Self-Review

**Spec coverage (§3):** scenario/day_plan table shapes ✅ (Task 1). Multi-scenario resolution in one phrase ✅ (`applyDayPlan` accepts `scenarioNames: string[]`, Task 3). `implies_next_day` auto-configuring tomorrow ✅ (Task 3's implied-scenario branch). Learning unknown formulations via one clarifying question then `create_scenario` ✅ — enforced through `ONBOARDING_TOOL`-style prompt instruction in `buildScenarioSystemPrompt`, not code (this is inherently a conversational/LLM behavior, not something deterministic code can force — same category as the spec's own "l'agent demande une fois" being a prompting concern). `usage_count` "sert à proposer le défaut" ✅ tracked (incremented on every apply) but **not yet consumed** — nothing proposes a default scenario for a weekday yet, because that's the morning-notification flow (v4 §14 step 9), not part of this step; noted so it isn't mistaken for a gap in this task.

**Placeholder scan:** none — every step has runnable code and concrete expected output.

**Type consistency:** `ToolHandler`'s new `(toolName, input)` shape (Task 2) matches its two call sites in Task 4 — `handleScenarioTool` already has that exact shape (Task 3), and the onboarding wrapper `(_name, input) => handleOnboardingTool(input)` adapts the older single-arg `handleOnboardingTool` to it inline, so no other onboarding files need to change. `CreateScenarioInput`/`ApplyDayPlanInput` (Task 3) match the tool schemas' `required` fields exactly.
