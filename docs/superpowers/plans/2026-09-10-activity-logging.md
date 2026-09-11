# Activity Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user tell the Telegram bot about a physical activity (with tracker-reported calories), compare it against what was already typical/planned for that day, and rebalance today's calorie target only when the gap is materially large — without ever biasing the long-run TDEE-observed calculation.

**Architecture:** A new conversational tool `log_activity` (`lib/activity.ts`) computes the calorie gap (reported vs. typical, per-sport discounted), writes an `ActivityLog` record for history, and — only when the discounted gap clears a 100 kcal threshold — upserts `DayPlan.eventBonusKcal` for that date. A small, additive change to `lib/dailyRecompute.ts` folds that bonus into the day's persisted `DailyState.targetKcal`, applied strictly *after* the existing weekly-adjustment calculation so `computeAdjustment` and `Profile.currentTargetKcal` never see it. The existing `DayPlan.isAtypical` → `DailyState.isExcluded` → 14-day-average-exclusion pipeline (already implemented and tested) keeps this one-off bonus from ever double-counting into the observed TDEE.

**Tech Stack:** TypeScript, Prisma (MongoDB), Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-activity-logging-design.md`

## Global Constraints

- No new npm dependencies.
- Per-sport discount table (exact values, applied to the **raw** diff *before* the materiality check): `cycling: 0.20`, `running: 0.25`, `strength: 0.30`, `other: 0.35`.
- Materiality threshold: `100` kcal, checked on the **discounted** diff, in absolute value (works for both positive and negative bonuses).
- No `WeeklyDefault` found for a weekday → treat `baselineKcal` as `0`.
- Multiple activities logged the same day → the latest call's `eventBonusKcal` simply overwrites the previous one on `DayPlan` (no accumulation). This is a known, documented v1 limitation — do not build accumulation logic.
- `computeAdjustment` and `Profile.currentTargetKcal` must never receive the bonus — only the per-day `DailyState.targetKcal` record does.

---

### Task 1: Prisma schema — `ActivityLog` model and `DayPlan.eventBonusKcal`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 2 and Task 3): Prisma Client types `ActivityLog` and `DayPlan.eventBonusKcal: number | null`, plus the generated `prisma.activityLog.create(...)` and `prisma.dayPlan.upsert(...)` methods used by later tasks.

- [ ] **Step 1: Add the field and the model**

In `prisma/schema.prisma`, modify the existing `DayPlan` model:

```prisma
model DayPlan {
  id               String   @id @default(auto()) @map("_id") @db.ObjectId
  date             String   @unique
  scenariosApplied String[]
  segmentsResolved Json
  confirmed        Boolean  @default(false)
  isAtypical       Boolean  @default(false)
  eventBonusKcal   Float?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}
```

Add a new model anywhere else in the file (e.g. right after `DayPlan`):

```prisma
model ActivityLog {
  id               String   @id @default(auto()) @map("_id") @db.ObjectId
  date             String
  description      String
  sportType        String
  reportedCalories Float
  relationToPlan   String
  baselineKcal     Float
  rawDiffKcal      Float
  discountPct      Float
  bonusKcal        Float
  createdAt        DateTime @default(now())
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: completes without error, prints the generated client location.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (nothing references the new fields yet, so this just confirms the schema change didn't break generation).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add ActivityLog model and DayPlan.eventBonusKcal field"
```

---

### Task 2: `lib/activity.ts` — the `log_activity` tool

**Files:**
- Create: `lib/activity.ts`
- Test: `tests/activity.test.ts`

**Interfaces:**
- Consumes: `prisma` (`lib/db.js`), `weekdayOf` (`lib/dateUtils.js`), `getWeeklyDefault` (`lib/weeklyScheduleStore.js`) — returns `{ avgKcal: number; activityType: string } | null` — , `getProfileSnapshot` (`lib/profile.js`) — returns `{ currentTargetKcal: number | null; ... }` —, `ToolDefinition` type (`lib/claude.js`).
- Produces (used by Task 4): `LOG_ACTIVITY_TOOL: ToolDefinition` (tool name `'log_activity'`) and `handleLogActivityTool(rawInput: Record<string, unknown>): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/activity.test.ts`:

```ts
import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleLogActivityTool } from '../lib/activity.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';

function baseProfile(currentTargetKcal: number | null) {
  return {
    weightKg: 80,
    ratePctPerWeek: 0.5,
    currentTargetKcal,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('handleLogActivityTool', () => {
  const dates = ['1999-07-05', '1999-07-06', '1999-07-07', '1999-07-08'];

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date: { in: dates } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: dates } } });
  });

  it('replaces a planned session and adds the discounted excess above threshold', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 300, activityType: 'course facile' });

    const result = await handleLogActivityTool({
      date: dates[0],
      description: 'vélo aller-retour gare',
      sportType: 'cycling',
      reportedCalories: 700,
      relationToPlan: 'replaces',
    });

    // rawDiff = 700 - 300 = 400; discounted = 400 * (1 - 0.20) = 320; |320| >= 100 -> bonus = 320
    expect(result).toContain('320');
    expect(result).toContain('2820'); // 2500 + 320

    const log = await prisma.activityLog.findFirst({ where: { date: dates[0] } });
    expect(log?.rawDiffKcal).toBeCloseTo(400, 5);
    expect(log?.discountPct).toBeCloseTo(0.2, 5);
    expect(log?.bonusKcal).toBeCloseTo(320, 5);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[0] } });
    expect(dayPlan?.isAtypical).toBe(true);
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(320, 5);
  });

  it('treats an additional activity as pure upside with no baseline subtraction', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 300, activityType: 'course facile' });

    const result = await handleLogActivityTool({
      date: dates[1],
      description: 'séance muscu du soir',
      sportType: 'strength',
      reportedCalories: 200,
      relationToPlan: 'additional',
    });

    // rawDiff = 200 (no baseline subtracted); discounted = 200 * (1 - 0.30) = 140; >= 100 -> bonus = 140
    expect(result).toContain('140');

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[1] } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(140, 5);
  });

  it('does not adjust the target when the discounted gap is below the materiality threshold', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 300, activityType: 'course facile' });

    const result = await handleLogActivityTool({
      date: dates[2],
      description: 'course facile comme prévu',
      sportType: 'running',
      reportedCalories: 350,
      relationToPlan: 'replaces',
    });

    // rawDiff = 350 - 300 = 50; discounted = 50 * (1 - 0.25) = 37.5; < 100 -> bonus = 0
    expect(result).toContain('trop faible');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[2] } });
    expect(log?.bonusKcal).toBe(0);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[2] } });
    expect(dayPlan).toBeNull();
  });

  it('reduces the target when the actual effort was well below what was planned', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 500, activityType: 'sortie longue' });

    const result = await handleLogActivityTool({
      date: dates[3],
      description: 'sortie écourtée',
      sportType: 'other',
      reportedCalories: 100,
      relationToPlan: 'replaces',
    });

    // rawDiff = 100 - 500 = -400; discounted = -400 * (1 - 0.35) = -260; |260| >= 100 -> bonus = -260
    expect(result).toContain('-260');
    expect(result).toContain('2240'); // 2500 - 260

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[3] } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(-260, 5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/activity.test.ts`
Expected: FAIL — `Cannot find module '../lib/activity.js'`.

- [ ] **Step 3: Implement `lib/activity.ts`**

```ts
import { prisma } from './db.js';
import { weekdayOf } from './dateUtils.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import { getProfileSnapshot } from './profile.js';
import type { ToolDefinition } from './claude.js';

export type SportType = 'cycling' | 'running' | 'strength' | 'other';

const SPORT_DISCOUNTS: Record<SportType, number> = {
  cycling: 0.2,
  running: 0.25,
  strength: 0.3,
  other: 0.35,
};

const MATERIALITY_THRESHOLD_KCAL = 100;

export interface LogActivityInput {
  date: string;
  description: string;
  sportType: SportType;
  reportedCalories: number;
  relationToPlan: 'replaces' | 'additional';
}

export const LOG_ACTIVITY_TOOL: ToolDefinition = {
  name: 'log_activity',
  description:
    "Enregistre une activité physique rapportée par l'utilisateur avec les calories affichées par sa montre/tracker. " +
    "Si l'utilisateur ne précise pas si cette activité REMPLACE l'activité initialement prévue pour la journée ou si elle est EN PLUS, " +
    "demande-le lui explicitement avant d'appeler cet outil — ne suppose jamais.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      description: { type: 'string' },
      sportType: { type: 'string', enum: ['cycling', 'running', 'strength', 'other'] },
      reportedCalories: { type: 'number' },
      relationToPlan: { type: 'string', enum: ['replaces', 'additional'] },
    },
    required: ['date', 'description', 'sportType', 'reportedCalories', 'relationToPlan'],
  },
};

export async function handleLogActivityTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogActivityInput;

  const weeklyDefault = await getWeeklyDefault(weekdayOf(input.date));
  const baselineKcal = weeklyDefault?.avgKcal ?? 0;

  const rawDiffKcal = input.relationToPlan === 'replaces' ? input.reportedCalories - baselineKcal : input.reportedCalories;

  const discountPct = SPORT_DISCOUNTS[input.sportType];
  const adjustedDiffKcal = rawDiffKcal * (1 - discountPct);
  const bonusKcal = Math.abs(adjustedDiffKcal) >= MATERIALITY_THRESHOLD_KCAL ? adjustedDiffKcal : 0;

  await prisma.activityLog.create({
    data: {
      date: input.date,
      description: input.description,
      sportType: input.sportType,
      reportedCalories: input.reportedCalories,
      relationToPlan: input.relationToPlan,
      baselineKcal,
      rawDiffKcal,
      discountPct,
      bonusKcal,
    },
  });

  if (bonusKcal === 0) {
    return `Activité enregistrée (${input.description}, ${input.reportedCalories} kcal). Écart avec le prévu trop faible (moins de ${MATERIALITY_THRESHOLD_KCAL} kcal après rabais) pour ajuster ta cible — considérée comme normale.`;
  }

  await prisma.dayPlan.upsert({
    where: { date: input.date },
    create: {
      date: input.date,
      scenariosApplied: [],
      segmentsResolved: [],
      isAtypical: true,
      eventBonusKcal: bonusKcal,
    },
    update: { isAtypical: true, eventBonusKcal: bonusKcal },
  });

  const profile = await getProfileSnapshot();
  const sign = bonusKcal > 0 ? '+' : '';
  const newTargetNote =
    profile.currentTargetKcal !== null ? ` → ${(profile.currentTargetKcal + bonusKcal).toFixed(0)} kcal aujourd'hui` : '';

  return `Activité enregistrée (${input.description}, ${input.reportedCalories} kcal, rabais ${(discountPct * 100).toFixed(0)}%). Cible du jour ajustée de ${sign}${bonusKcal.toFixed(0)} kcal${newTargetNote}.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/activity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/activity.ts tests/activity.test.ts
git commit -m "feat: add log_activity tool with per-sport discount and materiality threshold"
```

---

### Task 3: `lib/dailyRecompute.ts` — fold the day's bonus into the persisted target

**Files:**
- Modify: `lib/dailyRecompute.ts`
- Modify (test): `tests/dailyRecompute.test.ts`

**Interfaces:**
- Consumes: `dayPlans` (already fetched in this file's `Promise.all`, now typed with `eventBonusKcal: number | null` after Task 1).
- Produces: no new exports — `runDailyRecompute`'s existing `targetKcal` field (return value and persisted `DailyState.targetKcal`) now includes the day's bonus, if any, added strictly after the weekly-adjustment block.

- [ ] **Step 1: Write the failing test**

Add to `tests/dailyRecompute.test.ts`, as a new `it` inside the existing `describe('runDailyRecompute', ...)` block (after the last existing test, before the closing `});` of the describe). This test uses its **own** isolated date range (not `TEST_DATE`) so it cannot affect the other tests' shared fixtures:

```ts
  it("adds the day's eventBonusKcal to the persisted target without touching the profile update", async () => {
    const bonusDate = '1999-09-20';
    const bonusMealDates = ['1999-09-07', '1999-09-16', '1999-09-20'];
    const bonusWeightDates = ['1999-09-06', '1999-09-20'];

    const meals = await Promise.all([
      prisma.meal.create({
        data: {
          datetime: new Date('1999-09-07T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'bonus fixture day 1',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2200, proteinG: 150, carbsG: 200, fatG: 70 }],
          kcalLow: 2200,
          kcalMid: 2200,
          kcalHigh: 2200,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-09-16T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'bonus fixture day 2',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2400, proteinG: 160, carbsG: 220, fatG: 75 }],
          kcalLow: 2400,
          kcalMid: 2400,
          kcalHigh: 2400,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-09-20T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'bonus fixture day 3 (today)',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 800, proteinG: 50, carbsG: 90, fatG: 20 }],
          kcalLow: 800,
          kcalMid: 800,
          kcalHigh: 800,
          confidence: 'high',
        },
      }),
    ]);

    await prisma.weight.upsert({
      where: { date: '1999-09-06' },
      create: { date: '1999-09-06', weightKg: 82.0, source: 'manual' },
      update: { weightKg: 82.0 },
    });
    await prisma.weight.upsert({
      where: { date: '1999-09-20' },
      create: { date: '1999-09-20', weightKg: 80.0, source: 'manual' },
      update: { weightKg: 80.0 },
    });

    await prisma.dayPlan.upsert({
      where: { date: bonusDate },
      create: { date: bonusDate, scenariosApplied: [], segmentsResolved: [], isAtypical: false, eventBonusKcal: 250 },
      update: { isAtypical: false, eventBonusKcal: 250 },
    });

    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 2,
      weighInDay: null,
      reviewDay: null,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400, activityType: 'course facile' });
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(bonusDate);

    // Same fixture shape as the earlier "computes both TDEE estimates..." test (shifted 37 days),
    // so the baseline adjusted target before the bonus is the same: ~2600.
    expect(result.targetKcal).toBeCloseTo(2850, 5); // 2600 baseline + 250 bonus
    expect(applySpy).toHaveBeenCalledWith({
      currentTargetKcal: expect.closeTo(2600, 1), // profile baseline is NOT bonused
      lastAdjustmentDate: bonusDate,
      consecutiveDeficitWeeks: 3,
    });

    const dailyState = await prisma.dailyState.findFirst({ where: { date: bonusDate } });
    expect(dailyState?.targetKcal).toBeCloseTo(2850, 5);

    await Promise.all(meals.map((m) => prisma.meal.delete({ where: { id: m.id } })));
    await Promise.all(bonusWeightDates.map((d) => prisma.weight.deleteMany({ where: { date: d } })));
    await prisma.dayPlan.deleteMany({ where: { date: bonusDate } });
    await prisma.dailyState.deleteMany({ where: { date: bonusDate } });
    void bonusMealDates; // documents the dates used above; not asserted directly
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dailyRecompute.test.ts`
Expected: FAIL — `result.targetKcal` is `2600`, not `2850` (the bonus isn't applied yet).

- [ ] **Step 3: Implement the change in `lib/dailyRecompute.ts`**

Find this line (currently around line 91):

```ts
  const isAtypicalByDate = new Map(dayPlans.map((p) => [p.date, p.isAtypical]));
```

Add right after it:

```ts
  const eventBonusByDate = new Map(dayPlans.map((p) => [p.date, p.eventBonusKcal ?? 0]));
```

Then find the end of the big weekly-adjustment `if` block — the closing braces right before `const todayMacros = ...`:

```ts
      targetKcal = finalTargetKcal;
    }
  }

  const todayMacros = macrosByDate.get(date) ?? { proteinG: 0, carbsG: 0, fatG: 0 };
```

Insert the bonus application between the `if` block's closing `}` and `const todayMacros`:

```ts
      targetKcal = finalTargetKcal;
    }
  }

  const eventBonusKcal = eventBonusByDate.get(date) ?? 0;
  if (targetKcal !== null && eventBonusKcal !== 0) {
    targetKcal = targetKcal + eventBonusKcal;
  }

  const todayMacros = macrosByDate.get(date) ?? { proteinG: 0, carbsG: 0, fatG: 0 };
```

This is the only change to this file. `computeAdjustment` (called earlier, inside the `if` block, using the pre-bonus `targetKcal`) never sees the bonus — it stays computed purely from `profile.currentTargetKcal`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dailyRecompute.test.ts`
Expected: PASS (all tests in the file, existing + new).

- [ ] **Step 5: Commit**

```bash
git add lib/dailyRecompute.ts tests/dailyRecompute.test.ts
git commit -m "feat: fold DayPlan.eventBonusKcal into the day's persisted target"
```

---

### Task 4: Wire `log_activity` into the Telegram webhook

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify (test): `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `LOG_ACTIVITY_TOOL`, `handleLogActivityTool` from `lib/activity.js` (Task 2).
- Produces: `log_activity` becomes callable from the general chat flow (not the onboarding flow), exactly like `log_weight`/`log_meal`.

- [ ] **Step 1: Write the failing test change**

In `tests/webhook.test.ts`, add the import:

```ts
import { LOG_ACTIVITY_TOOL } from '../lib/activity.js';
```

Then, in **both** places where the full `GENERAL_CHAT_TOOLS` array is asserted (the `"responds 200 and replies with Claude's answer..."` test and the `"downloads a PDF document..."` test), add `LOG_ACTIVITY_TOOL` to the expected array, right after `TRIGGER_REBASELINE_TOOL`:

```ts
        SET_BODY_SCAN_TOOL,
        TRIGGER_REBASELINE_TOOL,
        LOG_ACTIVITY_TOOL,
        FLAG_CONCERN_TOOL,
```

(Both occurrences currently read `SET_BODY_SCAN_TOOL, TRIGGER_REBASELINE_TOOL, FLAG_CONCERN_TOOL,` in that order — insert `LOG_ACTIVITY_TOOL` between `TRIGGER_REBASELINE_TOOL` and `FLAG_CONCERN_TOOL` in both.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — the two tests asserting the tool array mismatch (actual array is missing `LOG_ACTIVITY_TOOL`).

- [ ] **Step 3: Implement the change in `api/telegram/webhook.ts`**

Add the import, alongside the other tool imports:

```ts
import { LOG_ACTIVITY_TOOL, handleLogActivityTool } from '../../lib/activity.js';
```

Add to `GENERAL_CHAT_TOOLS`, in the same position as the test expects (between `TRIGGER_REBASELINE_TOOL` and `FLAG_CONCERN_TOOL`):

```ts
const GENERAL_CHAT_TOOLS = [
  ...SCENARIO_TOOLS,
  SET_WEEKLY_SCHEDULE_TOOL,
  LOG_WEIGHT_TOOL,
  LOG_MEAL_TOOL,
  LOG_WEIGHED_MEAL_TOOL,
  SET_BODY_SCAN_TOOL,
  TRIGGER_REBASELINE_TOOL,
  LOG_ACTIVITY_TOOL,
  FLAG_CONCERN_TOOL,
];
```

Add the dispatch line in `handleGeneralChatTool`:

```ts
async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  if (name === 'log_weighed_meal') return handleLogWeighedMealTool(input);
  if (name === 'set_body_scan') return handleSetBodyScanTool(input);
  if (name === 'trigger_rebaseline') return handleTriggerRebaselineTool(input);
  if (name === 'log_activity') return handleLogActivityTool(input);
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: wire log_activity into the general chat tools"
```

---

### Task 5: Full verification and deploy

**Files:** none (verification + deploy only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: every test file touched by this plan passes. Any failures in unrelated files (pre-existing flakiness already observed this session, e.g. a Ciqual search timeout) are not this plan's concern — re-run that single file in isolation to confirm it's unrelated before proceeding.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Deploy**

```bash
git push origin master
```
Vercel's Git integration auto-deploys on push to `master` (configured earlier this session). Confirm with:
```bash
npx vercel ls
```

- [ ] **Step 4: Manual conversation test**

Message the Telegram bot something like "j'ai fait du vélo, ma montre dit 500 kcal" without specifying whether it replaces or adds to today's plan. Confirm the bot asks for that clarification before calling `log_activity`, then confirm the response states the computed bonus and new target correctly.

---

## Self-Review Notes

- **Spec coverage:** calculation formula (Task 2), `ActivityLog` model + `DayPlan.eventBonusKcal` (Task 1), `log_activity` tool + prompt instruction to ask for clarification (Task 2), `dailyRecompute` integration that doesn't touch `computeAdjustment`/profile baseline (Task 3), webhook wiring (Task 4), edge cases — no `WeeklyDefault` → baseline 0 (covered by `?? 0` in Task 2's implementation), multiple activities same day → last-wins (documented in Global Constraints, naturally follows from the `upsert` in Task 2, no extra code needed) — all covered.
- **Placeholder scan:** none found — every step has literal code or an exact command.
- **Type consistency:** `LogActivityInput`, `SportType`, `LOG_ACTIVITY_TOOL`, `handleLogActivityTool` names match exactly between Task 2's implementation and Task 4's consumption. `eventBonusKcal` field name matches exactly between Task 1's schema, Task 2's `dayPlan.upsert`, and Task 3's `eventBonusByDate` map.
