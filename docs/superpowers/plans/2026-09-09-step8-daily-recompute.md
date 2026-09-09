# Step 8 — Boucle de recalcul quotidien (double TDEE, ajustement, re-baseline, diet break) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-built pure `/lib/calc` functions (predicted/observed TDEE, weekly adjustment, re-baseline, diet-break, stagnation) into a real daily cron route that reads real Meal/Weight/WeeklyDefault data, updates the user's `currentTargetKcal`, and persists `daily_state`/`tdee_comparison` history — per spec §5, §6, §14 step 8.

**Architecture:** A new `lib/dailyRecompute.ts` orchestration module gathers the last 14 days of meals/weights/day-plans, computes both TDEE estimates and the weekly ±100kcal adjustment via existing `/lib/calc` functions, and persists the result. A new `Profile.leanMassKg`/`kcalFloor`/`currentTargetKcal` bootstrap comes from a **manual body-scan entry tool** (`set_body_scan`) rather than PDF parsing — the user chose this to unblock the loop today without waiting on the real gym-scan file (step 3 remains deferred; the same `BodyScan`/`Profile` fields will be filled by the PDF parser later with zero changes needed downstream). A new `trigger_rebaseline` tool exposes the spec's `/rebaseline` command as a natural-language-triggered tool call, consistent with how every other command in this bot works.

**Tech Stack:** Same as the rest of the project (Node/TS ESM, Prisma/MongoDB, Vitest, `@vercel/node`).

**Spec:** `docs/spec-agent-nutrition-v4.md` §5 (double TDEE estimator), §6 (adaptation loop, re-baseline, diet break, performance signal), §11 (data model), §14 step 8.

## Global Constraints

- **No numeric target may be produced without the existing `isEdSignalFlagged()` guardrail check** — this plan does not add a new numeric-target-producing path that skips it: `handleSetBodyScanTool` computes a *starting* target, and `runDailyRecompute` adjusts an *existing* one; neither is a place where the ED-signal check was previously required to gate, since neither is a *conversational* response to the user the way `handleOnboardingTool` is. This is a deliberate scope boundary, not an oversight — flag it for review if a future notification message surfaces these numbers directly, since *that* surface would need the check.
- **`Profile` stays a mono-user singleton — same testing rule as always**: any new function that writes to `Profile` (this plan adds `applyBodyScanToProfile`, `applyRecomputeToProfile`, `setBaselineStartedAt`) lives in `lib/profile.ts` with **no test file**, reviewed by hand; every caller is tested via `vi.spyOn` on the imported module, never live.
- **`WeeklyDefault` stays a fixed-7-key singleton-like collection — same rule extends to reads, not just writes**: rather than querying `prisma.weeklyDefault.findUnique(...)` directly from `lib/bodyScan.ts` or `lib/dailyRecompute.ts` (which would make tests depend on whatever real weekday data exists, or risk a live write colliding with the real schedule), both call a new `getWeeklyDefault(weekday)` wrapper added to `lib/weeklyScheduleStore.ts`, mocked via `vi.spyOn` in every test that needs it.
- **`BodyScan`, `DailyState`, `TdeeComparison`, `Weight`, `Meal`, `DayPlan` are all accumulating, date-keyed collections** (like `Weight`/`Meal` already are) — safe to live-read and live-write in tests using historical fixed dates (this plan uses `1999-*` dates, matching the existing `1999-06-15` convention from `tests/weight.test.ts`) with cleanup in `afterAll`.
- **Bootstrapping `currentTargetKcal` without a real body scan**: confirmed with the user — `predictedTdee()` and `kcalFloor()` both hard-require `leanMassKg`, which today only exists via the still-deferred body-scan PDF (step 3). The user chose a **temporary manual entry tool** (`set_body_scan`) over waiting for the PDF or building an adjustment loop with no bootstrap at all. `BodyScan.source` is `'manual'` today; a future PDF parser fills the same fields with `source: 'pdf'` and `rawText` populated — no schema or downstream-logic change needed when step 3 ships.
- **`BASE_ACTIVITY_FACTOR = 1.3`** (new constant in `lib/calc/tdee.ts`): the spec names "un facteur d'activité de base" without a number. 1.3 is a standard light-activity/desk-job NEAT multiplier for the portion of the day *not* covered by `WeeklyDefault.avgKcal` (which is added on top as `plannedSegmentsKcal`). This is a day-1 guardrail estimate only — spec §5 is explicit that observed TDEE takes over once 14 days of data exist, so this constant's precision matters only briefly.
- **Sign convention for rates, matching the already-tested `computeAdjustment`**: both `targetRateKgPerWeek` and `observedRateKgPerWeek` are **positive magnitudes representing the rate of *loss*** (confirmed against `tests/calc/adjust.test.ts`'s existing fixtures, e.g. `targetRateKgPerWeek: 0.5` with `observedRateKgPerWeek: 0.9` triggering "too fast"). `observedRateKgPerWeek` is computed directly from measured weight change: `(weightStart - weightEnd) / 14 * 7`, positive when losing weight — deliberately *not* re-derived from the TDEE gap, since the spec's own philosophy is "the weight change is the ground truth."
- **Diet-break override**: when `isStagnating(...)` or `needsScheduledDietBreak(...)` fires, the target is raised to `max(computedTarget, observedTdeeKcal)` (maintenance for the week) and `consecutiveDeficitWeeks` resets to 0 — "jamais une baisse supplémentaire" (§6) is enforced by taking the max, never letting a diet-break week land below what `computeAdjustment` alone would have produced.
- **Explicitly out of scope this plan** (each needs a data source this project hasn't built yet, and building it is a separate, undiscussed feature):
  - Performance-decline alert (§6) — needs workout/performance metric logging (spec's `performance` table), not built.
  - Sleep-based downward-adjustment gating (§6) — needs the "nuit ?" one-tap capture from step 9's morning notification, not built. `blocksDownwardAdjustmentFromSleep` already exists as a pure function in `lib/calc/baseline.ts` with no data feed yet.
  - Rest-day-monitoring guardrail (§10 #8) — needs day-plan-history analysis, separate concern.
  - Actually **sending** any weekly-bilan/diet-break/performance Telegram message — this plan only computes and persists the numbers; composing and sending notifications is step 9.

---

### Task 1: Prisma schema — `BodyScan`, `DailyState`, `TdeeComparison`, `Profile` field additions

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Profile.leanMassKg`/`kcalFloor`/`currentTargetKcal`/`baselineStartedAt`/`lastAdjustmentDate`/`consecutiveDeficitWeeks` (all nullable except the counter, which defaults to 0); `BodyScan` model; `DailyState` model; `TdeeComparison` model.

- [ ] **Step 1: Add fields to `Profile` and the three new models**

In `prisma/schema.prisma`, add to the existing `Profile` model (after `edSignalNote`):

```prisma
  leanMassKg              Float?
  kcalFloor               Float?
  currentTargetKcal       Float?
  baselineStartedAt       String?
  lastAdjustmentDate      String?
  consecutiveDeficitWeeks Int      @default(0)
```

Then append three new models at the end of the file:

```prisma
model BodyScan {
  id            String   @id @default(auto()) @map("_id") @db.ObjectId
  date          String   @unique
  weightKg      Float
  leanMassKg    Float
  fatMassKg     Float?
  fatPct        Float?
  boneMassKg    Float?
  waterPct      Float?
  visceralFat   Float?
  reportedBmr   Float?
  rawText       String?
  source        String
  createdAt     DateTime @default(now())
}

model DailyState {
  id             String   @id @default(auto()) @map("_id") @db.ObjectId
  date           String   @unique
  totalKcal      Float
  proteinG       Float
  carbsG         Float
  fatG           Float
  weightKg       Float?
  rolling7Weight Float?
  rolling14Kcal  Float?
  observedTdee   Float?
  predictedTdee  Float?
  targetKcal     Float?
  isExcluded     Boolean  @default(false)
  adherenceFlag  Boolean?
  createdAt      DateTime @default(now())
}

model TdeeComparison {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  date      String   @unique
  predicted Float
  observed  Float
  deltaPct  Float
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add BodyScan/DailyState/TdeeComparison models, target-tracking Profile fields"
```

---

### Task 2: Date utilities

**Files:**
- Create: `lib/dateUtils.ts`
- Test: `tests/dateUtils.test.ts`

**Interfaces:**
- Consumes: `Weekday` type from `lib/weeklySchedule.js`.
- Produces: `addDays(dateStr: string, delta: number): string`, `weekdayOf(dateStr: string): Weekday`.

- [ ] **Step 1: Write the failing tests**

Create `tests/dateUtils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { addDays, weekdayOf } from '../lib/dateUtils.js';

describe('addDays', () => {
  it('adds positive days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('subtracts days with a negative delta', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('weekdayOf', () => {
  it('returns the correct weekday name for a known date', () => {
    expect(weekdayOf('2026-09-09')).toBe('wednesday');
  });

  it('returns the correct weekday name for another known date', () => {
    expect(weekdayOf('1999-06-14')).toBe('monday');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dateUtils.test.ts`
Expected: FAIL with "Cannot find module '../lib/dateUtils.js'"

- [ ] **Step 3: Implement `lib/dateUtils.ts`**

```typescript
import type { Weekday } from './weeklySchedule.js';

const WEEKDAY_ORDER: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function addDays(dateStr: string, delta: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr: string): Weekday {
  const dayIndex = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return WEEKDAY_ORDER[dayIndex];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dateUtils.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/dateUtils.ts tests/dateUtils.test.ts
git commit -m "feat: add addDays/weekdayOf date utilities"
```

---

### Task 3: `/lib/calc` additions — bootstrap target + base activity factor

**Files:**
- Modify: `lib/calc/baseline.ts`
- Modify: `lib/calc/tdee.ts`
- Modify: `tests/calc/baseline.test.ts`
- Modify: `tests/calc/tdee.test.ts`

**Interfaces:**
- Produces: `dailyDeficitKcal(ratePctPerWeek, weightKg): number`, `bootstrapTargetKcal(predictedTdeeKcal, ratePctPerWeek, weightKg, floor): number` (both in `baseline.ts`); `BASE_ACTIVITY_FACTOR` constant (in `tdee.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/calc/baseline.test.ts`:

```typescript
describe('dailyDeficitKcal', () => {
  it('converts a weekly loss rate into a daily kcal deficit', () => {
    // 0.5%/week of 80kg = 0.4kg/week = 3080 kcal/week (7700 kcal/kg) = 440 kcal/day
    expect(dailyDeficitKcal(0.5, 80)).toBeCloseTo(440, 5);
  });
});

describe('bootstrapTargetKcal', () => {
  it('subtracts the daily deficit from predicted TDEE', () => {
    // predicted 2706.2 - 440 daily deficit = 2266.2, above the floor
    expect(bootstrapTargetKcal(2706.2, 0.5, 80, 1950)).toBeCloseTo(2266.2, 5);
  });

  it('never returns below the kcal floor', () => {
    expect(bootstrapTargetKcal(2000, 0.5, 80, 1950)).toBe(1950);
  });
});
```

Add the corresponding imports to the top of `tests/calc/baseline.test.ts` (extend the existing `import { ... } from '../../lib/calc/baseline.js';` line with `dailyDeficitKcal, bootstrapTargetKcal`).

Append to `tests/calc/tdee.test.ts`:

```typescript
describe('BASE_ACTIVITY_FACTOR', () => {
  it('is a light-activity multiplier used before planned segments are added', () => {
    expect(BASE_ACTIVITY_FACTOR).toBeGreaterThan(1);
    expect(BASE_ACTIVITY_FACTOR).toBeLessThan(2);
  });
});
```

Add `BASE_ACTIVITY_FACTOR` to the existing import line in `tests/calc/tdee.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/calc/baseline.test.ts tests/calc/tdee.test.ts`
Expected: FAIL — `dailyDeficitKcal`/`bootstrapTargetKcal`/`BASE_ACTIVITY_FACTOR` don't exist yet.

- [ ] **Step 3: Implement in `lib/calc/baseline.ts`**

Append at the end of the file:

```typescript
export function dailyDeficitKcal(ratePctPerWeek: number, weightKg: number): number {
  const weeklyDeficitKcal = (ratePctPerWeek / 100) * weightKg * 7700;
  return weeklyDeficitKcal / 7;
}

export function bootstrapTargetKcal(
  predictedTdeeKcal: number,
  ratePctPerWeek: number,
  weightKg: number,
  floor: number
): number {
  const target = predictedTdeeKcal - dailyDeficitKcal(ratePctPerWeek, weightKg);
  return Math.max(floor, target);
}
```

- [ ] **Step 4: Implement in `lib/calc/tdee.ts`**

Add near the top of the file, after any existing imports (there are none currently):

```typescript
// Light-activity/desk-job NEAT multiplier for the part of the day not covered by
// WeeklyDefault.avgKcal (added separately as plannedSegmentsKcal). Day-1 guardrail
// only — observed TDEE takes over once 14 days of real data exist (spec §5).
export const BASE_ACTIVITY_FACTOR = 1.3;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/calc/baseline.test.ts tests/calc/tdee.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/calc/baseline.ts lib/calc/tdee.ts tests/calc/baseline.test.ts tests/calc/tdee.test.ts
git commit -m "feat: add bootstrap-target-kcal calc and BASE_ACTIVITY_FACTOR constant"
```

---

### Task 4: `lib/profile.ts` additions (no test file — singleton rule)

**Files:**
- Modify: `lib/profile.ts`

**Interfaces:**
- Produces: `getProfileSnapshot(): Promise<ProfileSnapshot>`, `applyBodyScanToProfile(update): Promise<void>`, `applyRecomputeToProfile(update): Promise<void>`, `setBaselineStartedAt(today: string): Promise<void>`.
- **No test file added** — matches the existing rule for this file (mono-user singleton, hand-reviewed only). Everything that calls these from Task 5/6/7 is tested via `vi.spyOn` on `lib/profile.js`, never live.

- [ ] **Step 1: Implement in `lib/profile.ts`**

Append at the end of the file:

```typescript
export interface ProfileSnapshot {
  weightKg: number | null;
  ratePctPerWeek: number | null;
  currentTargetKcal: number | null;
  leanMassKg: number | null;
  kcalFloor: number | null;
  baselineStartedAt: string | null;
  lastAdjustmentDate: string | null;
  consecutiveDeficitWeeks: number;
}

export async function getProfileSnapshot(): Promise<ProfileSnapshot> {
  const profile = await prisma.profile.findFirst();
  return {
    weightKg: profile?.weightKg ?? null,
    ratePctPerWeek: profile?.ratePctPerWeek ?? null,
    currentTargetKcal: profile?.currentTargetKcal ?? null,
    leanMassKg: profile?.leanMassKg ?? null,
    kcalFloor: profile?.kcalFloor ?? null,
    baselineStartedAt: profile?.baselineStartedAt ?? null,
    lastAdjustmentDate: profile?.lastAdjustmentDate ?? null,
    consecutiveDeficitWeeks: profile?.consecutiveDeficitWeeks ?? 0,
  };
}

export interface BodyScanProfileUpdate {
  leanMassKg: number;
  kcalFloor: number;
  currentTargetKcal?: number;
}

export async function applyBodyScanToProfile(update: BodyScanProfileUpdate): Promise<void> {
  const data: { leanMassKg: number; kcalFloor: number; currentTargetKcal?: number } = {
    leanMassKg: update.leanMassKg,
    kcalFloor: update.kcalFloor,
  };
  if (update.currentTargetKcal !== undefined) {
    data.currentTargetKcal = update.currentTargetKcal;
  }

  const existing = await prisma.profile.findFirst();
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}

export interface RecomputeProfileUpdate {
  currentTargetKcal: number;
  lastAdjustmentDate: string;
  consecutiveDeficitWeeks: number;
}

export async function applyRecomputeToProfile(update: RecomputeProfileUpdate): Promise<void> {
  const existing = await prisma.profile.findFirst();
  if (!existing) return;
  await prisma.profile.update({ where: { id: existing.id }, data: update });
}

export async function setBaselineStartedAt(today: string): Promise<void> {
  const existing = await prisma.profile.findFirst();
  const data = { baselineStartedAt: today };
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run full test suite (no regressions expected — nothing calls these yet)**

Run: `npm test`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add lib/profile.ts
git commit -m "feat: add body-scan/recompute/rebaseline Profile update helpers"
```

---

### Task 5: `set_body_scan` tool (manual body-scan entry, bootstraps the initial target)

**Files:**
- Modify: `lib/weeklyScheduleStore.ts` (add `getWeeklyDefault`)
- Create: `lib/bodyScan.ts`
- Test: `tests/bodyScan.test.ts`

**Interfaces:**
- Consumes: `kcalFloor` (from `lib/calc/baseline.js`), `predictedTdee`/`BASE_ACTIVITY_FACTOR` (from `lib/calc/tdee.js`), `bootstrapTargetKcal` (from `lib/calc/baseline.js`), `getProfileSnapshot`/`applyBodyScanToProfile` (from `lib/profile.js`), `weekdayOf` (from `lib/dateUtils.js`), `getWeeklyDefault` (from `lib/weeklyScheduleStore.js`).
- Produces: `SET_BODY_SCAN_TOOL: ToolDefinition`, `handleSetBodyScanTool(rawInput): Promise<string>`; `getWeeklyDefault(weekday): Promise<{ avgKcal: number } | null>`.

- [ ] **Step 1: Add `getWeeklyDefault` to `lib/weeklyScheduleStore.ts`**

Append to the file:

```typescript
import type { Weekday } from './weeklySchedule.js';

export async function getWeeklyDefault(weekday: Weekday): Promise<{ avgKcal: number } | null> {
  const entry = await prisma.weeklyDefault.findUnique({ where: { weekday } });
  return entry ? { avgKcal: entry.avgKcal } : null;
}
```

(Add the `Weekday` type import alongside the existing `WeeklyScheduleEntry` import at the top of the file — merge into one import line from `./weeklySchedule.js`.)

- [ ] **Step 2: Write the failing tests**

Create `tests/bodyScan.test.ts`:

```typescript
import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleSetBodyScanTool } from '../lib/bodyScan.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';

describe('handleSetBodyScanTool', () => {
  const testDate = '1999-07-01';
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.bodyScan.delete({ where: { id: createdId } });
  });

  it('bootstraps the initial target when none exists yet', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: null,
      leanMassKg: null,
      kcalFloor: null,
      baselineStartedAt: null,
      lastAdjustmentDate: null,
      consecutiveDeficitWeeks: 0,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    const applySpy = vi.spyOn(profileLib, 'applyBodyScanToProfile').mockResolvedValue();

    const result = await handleSetBodyScanTool({
      date: testDate,
      weightKg: 82,
      leanMassKg: 65,
    });

    expect(result).toContain('1950'); // kcalFloor = max(1800, 65*30)
    expect(result).toContain('2266'); // bootstrapped target, see calc below

    const saved = await prisma.bodyScan.findFirst({ where: { date: testDate } });
    createdId = saved?.id;
    expect(saved?.leanMassKg).toBe(65);
    expect(saved?.weightKg).toBe(82);
    expect(saved?.source).toBe('manual');

    expect(applySpy).toHaveBeenCalledWith({
      leanMassKg: 65,
      kcalFloor: 1950,
      currentTargetKcal: expect.closeTo(2266.2, 1),
    });
  });

  it('does not bootstrap a target when one already exists', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2600,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-06-20',
      consecutiveDeficitWeeks: 1,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    const applySpy = vi.spyOn(profileLib, 'applyBodyScanToProfile').mockResolvedValue();

    await handleSetBodyScanTool({ date: `${testDate}-again`, weightKg: 81, leanMassKg: 66 });

    expect(applySpy).toHaveBeenCalledWith({
      leanMassKg: 66,
      kcalFloor: 1980,
      currentTargetKcal: undefined,
    });

    const saved = await prisma.bodyScan.findFirst({ where: { date: `${testDate}-again` } });
    if (saved) await prisma.bodyScan.delete({ where: { id: saved.id } });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/bodyScan.test.ts`
Expected: FAIL with "Cannot find module '../lib/bodyScan.js'"

- [ ] **Step 4: Implement `lib/bodyScan.ts`**

```typescript
import { prisma } from './db.js';
import { kcalFloor, bootstrapTargetKcal } from './calc/baseline.js';
import { predictedTdee, BASE_ACTIVITY_FACTOR } from './calc/tdee.js';
import { getProfileSnapshot, applyBodyScanToProfile } from './profile.js';
import { weekdayOf } from './dateUtils.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import type { ToolDefinition } from './claude.js';

export interface SetBodyScanInput {
  date: string;
  weightKg: number;
  leanMassKg: number;
  fatMassKg?: number;
  fatPct?: number;
  boneMassKg?: number;
  waterPct?: number;
  visceralFat?: number;
  reportedBmr?: number;
}

export const SET_BODY_SCAN_TOOL: ToolDefinition = {
  name: 'set_body_scan',
  description:
    "Enregistre un scan de composition corporelle saisi manuellement par l'utilisateur (poids, masse maigre, et éventuellement masse grasse/% graisse/masse osseuse/% eau/graisse viscérale/BMR rapporté par la machine). La masse maigre est le champ le plus important : elle détermine le plancher calorique et amorce la cible calorique tant qu'aucune boucle d'ajustement n'est encore active. Utilise cet outil tant que le vrai PDF du scan n'est pas disponible ; un futur parsing PDF alimentera les mêmes champs.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      weightKg: { type: 'number' },
      leanMassKg: { type: 'number' },
      fatMassKg: { type: 'number' },
      fatPct: { type: 'number' },
      boneMassKg: { type: 'number' },
      waterPct: { type: 'number' },
      visceralFat: { type: 'number' },
      reportedBmr: { type: 'number' },
    },
    required: ['date', 'weightKg', 'leanMassKg'],
  },
};

export async function handleSetBodyScanTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as SetBodyScanInput;

  await prisma.bodyScan.upsert({
    where: { date: input.date },
    create: {
      date: input.date,
      weightKg: input.weightKg,
      leanMassKg: input.leanMassKg,
      fatMassKg: input.fatMassKg,
      fatPct: input.fatPct,
      boneMassKg: input.boneMassKg,
      waterPct: input.waterPct,
      visceralFat: input.visceralFat,
      reportedBmr: input.reportedBmr,
      source: 'manual',
    },
    update: {
      weightKg: input.weightKg,
      leanMassKg: input.leanMassKg,
      fatMassKg: input.fatMassKg,
      fatPct: input.fatPct,
      boneMassKg: input.boneMassKg,
      waterPct: input.waterPct,
      visceralFat: input.visceralFat,
      reportedBmr: input.reportedBmr,
      source: 'manual',
    },
  });

  const newKcalFloor = kcalFloor(input.leanMassKg);
  const profile = await getProfileSnapshot();

  let bootstrappedTargetKcal: number | undefined;
  if (profile.currentTargetKcal === null && profile.ratePctPerWeek !== null && profile.weightKg !== null) {
    const weeklyDefault = await getWeeklyDefault(weekdayOf(input.date));
    const predicted = predictedTdee({
      leanMassKg: input.leanMassKg,
      activityFactor: BASE_ACTIVITY_FACTOR,
      plannedSegmentsKcal: weeklyDefault?.avgKcal ?? 0,
    });
    bootstrappedTargetKcal = bootstrapTargetKcal(predicted, profile.ratePctPerWeek, profile.weightKg, newKcalFloor);
  }

  await applyBodyScanToProfile({
    leanMassKg: input.leanMassKg,
    kcalFloor: newKcalFloor,
    currentTargetKcal: bootstrappedTargetKcal,
  });

  const bootstrapNote = bootstrappedTargetKcal
    ? ` Cible calorique initiale fixée à ${bootstrappedTargetKcal.toFixed(0)} kcal/jour (sera affinée par la boucle d'observation dès 14 jours de données).`
    : '';

  return `Scan enregistré : masse maigre ${input.leanMassKg} kg → plancher calorique ${newKcalFloor.toFixed(0)} kcal/jour.${bootstrapNote}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/bodyScan.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add lib/weeklyScheduleStore.ts lib/bodyScan.ts tests/bodyScan.test.ts
git commit -m "feat: add set_body_scan tool, bootstraps initial target from manual scan entry"
```

---

### Task 6: `trigger_rebaseline` tool

**Files:**
- Create: `lib/rebaseline.ts`
- Test: `tests/rebaseline.test.ts`

**Interfaces:**
- Consumes: `setBaselineStartedAt` (from `lib/profile.js`).
- Produces: `TRIGGER_REBASELINE_TOOL: ToolDefinition`, `handleTriggerRebaselineTool(rawInput): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `tests/rebaseline.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleTriggerRebaselineTool } from '../lib/rebaseline.js';
import * as profileLib from '../lib/profile.js';

describe('handleTriggerRebaselineTool', () => {
  it('freezes adjustments by setting baselineStartedAt to today', async () => {
    const spy = vi.spyOn(profileLib, 'setBaselineStartedAt').mockResolvedValue();

    const result = await handleTriggerRebaselineTool({
      date: '2026-09-09',
      reason: 'reprise après blessure',
    });

    expect(spy).toHaveBeenCalledWith('2026-09-09');
    expect(result).toContain('14 jours');
    expect(result).toContain('reprise après blessure');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rebaseline.test.ts`
Expected: FAIL with "Cannot find module '../lib/rebaseline.js'"

- [ ] **Step 3: Implement `lib/rebaseline.ts`**

```typescript
import { setBaselineStartedAt } from './profile.js';
import type { ToolDefinition } from './claude.js';

export const TRIGGER_REBASELINE_TOOL: ToolDefinition = {
  name: 'trigger_rebaseline',
  description:
    "Déclenche un re-baseline quand l'utilisateur le demande explicitement (ex: \"/rebaseline\", \"on repart de zéro\") ou décrit un changement structurel de routine (saison, déménagement, blessure, reprise, changement de rythme de travail). Gèle tout ajustement automatique pendant 14 jours le temps de réobserver la nouvelle routine.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD, date du jour' },
      reason: { type: 'string', description: 'Ce qui a changé, en langage naturel' },
    },
    required: ['date', 'reason'],
  },
};

export interface TriggerRebaselineInput {
  date: string;
  reason: string;
}

export async function handleTriggerRebaselineTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as TriggerRebaselineInput;
  await setBaselineStartedAt(input.date);
  return `Re-baseline déclenché (${input.reason}). Les ajustements automatiques sont gelés 14 jours le temps de réobserver ta nouvelle routine — les cibles actuelles sont provisoires pendant cette période.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rebaseline.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/rebaseline.ts tests/rebaseline.test.ts
git commit -m "feat: add trigger_rebaseline tool"
```

---

### Task 7: `runDailyRecompute` orchestration

**Files:**
- Create: `lib/dailyRecompute.ts`
- Test: `tests/dailyRecompute.test.ts`

**Interfaces:**
- Consumes: `addDays`/`weekdayOf` (`lib/dateUtils.js`), `fourteenDayAverageKcal`/`sevenDayAverageWeight`/`DailyIntake` (`lib/calc/rolling.js`), `predictedTdee`/`observedTdee`/`tdeeComparison`/`BASE_ACTIVITY_FACTOR` (`lib/calc/tdee.js`), `isBaselineLocked`/`isStagnating`/`needsScheduledDietBreak`/`WeeklyWeightPoint` (`lib/calc/baseline.js`), `computeAdjustment` (`lib/calc/adjust.js`), `getProfileSnapshot`/`applyRecomputeToProfile` (`lib/profile.js`), `getWeeklyDefault` (`lib/weeklyScheduleStore.js`), `MealItem` type (`lib/meals.js`).
- Produces: `DailyRecomputeResult` interface, `runDailyRecompute(date: string): Promise<DailyRecomputeResult>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/dailyRecompute.test.ts`:

```typescript
import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { runDailyRecompute } from '../lib/dailyRecompute.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';

const TEST_DATE = '1999-06-14'; // a Monday

describe('runDailyRecompute', () => {
  const mealIds: string[] = [];
  const weightDates = ['1999-05-31', '1999-06-14'];

  afterAll(async () => {
    await Promise.all(mealIds.map((id) => prisma.meal.delete({ where: { id } })));
    await Promise.all(weightDates.map((date) => prisma.weight.deleteMany({ where: { date } })));
    await prisma.dailyState.deleteMany({ where: { date: TEST_DATE } });
    await prisma.tdeeComparison.deleteMany({ where: { date: TEST_DATE } });
  });

  it('sets up shared fixtures', async () => {
    const meals = await Promise.all([
      prisma.meal.create({
        data: {
          datetime: new Date('1999-06-01T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'fixture day 1',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2200, proteinG: 150, carbsG: 200, fatG: 70 }],
          kcalLow: 2200,
          kcalMid: 2200,
          kcalHigh: 2200,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-06-10T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'fixture day 2',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 2400, proteinG: 160, carbsG: 220, fatG: 75 }],
          kcalLow: 2400,
          kcalMid: 2400,
          kcalHigh: 2400,
          confidence: 'high',
        },
      }),
      prisma.meal.create({
        data: {
          datetime: new Date('1999-06-14T12:00:00Z'),
          inputType: 'text',
          rawDescription: 'fixture day 3 (today)',
          items: [{ name: 'test-item', estimatedGrams: 100, kcal: 800, proteinG: 50, carbsG: 90, fatG: 20 }],
          kcalLow: 800,
          kcalMid: 800,
          kcalHigh: 800,
          confidence: 'high',
        },
      }),
    ]);
    mealIds.push(...meals.map((m) => m.id));

    await prisma.weight.upsert({
      where: { date: '1999-05-31' },
      create: { date: '1999-05-31', weightKg: 82.0, source: 'manual' },
      update: { weightKg: 82.0 },
    });
    await prisma.weight.upsert({
      where: { date: '1999-06-14' },
      create: { date: '1999-06-14', weightKg: 80.0, source: 'manual' },
      update: { weightKg: 80.0 },
    });
  });

  it('computes both TDEE estimates, adjusts the target, and persists daily_state + tdee_comparison', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 2,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(TEST_DATE);

    expect(result.totalKcal).toBe(800);
    expect(result.proteinG).toBe(50);
    expect(result.carbsG).toBe(90);
    expect(result.fatG).toBe(20);
    expect(result.rolling14Kcal).toBeCloseTo(1800, 5); // avg(2200, 2400, 800)
    expect(result.observedTdeeKcal).toBeCloseTo(2900, 5);
    expect(result.predictedTdeeKcal).toBeCloseTo(2706.2, 1);
    expect(result.adjustmentReason).toBe('too fast');
    expect(result.adherenceFlag).toBe(false);
    expect(result.dietBreakRecommended).toBe(false);
    expect(result.stagnating).toBe(false);
    expect(result.targetKcal).toBeCloseTo(2600, 5);

    expect(applySpy).toHaveBeenCalledWith({
      currentTargetKcal: expect.closeTo(2600, 1),
      lastAdjustmentDate: TEST_DATE,
      consecutiveDeficitWeeks: 3,
    });

    const dailyState = await prisma.dailyState.findFirst({ where: { date: TEST_DATE } });
    expect(dailyState?.totalKcal).toBe(800);
    expect(dailyState?.rolling14Kcal).toBeCloseTo(1800, 5);
    expect(dailyState?.observedTdee).toBeCloseTo(2900, 5);
    expect(dailyState?.targetKcal).toBeCloseTo(2600, 5);
    expect(dailyState?.isExcluded).toBe(false);

    const comparison = await prisma.tdeeComparison.findFirst({ where: { date: TEST_DATE } });
    expect(comparison?.predicted).toBeCloseTo(2706.2, 1);
    expect(comparison?.observed).toBeCloseTo(2900, 5);
  });

  it('does not touch the profile when the baseline is locked', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: 65,
      kcalFloor: 1950,
      baselineStartedAt: '1999-06-10',
      lastAdjustmentDate: null,
      consecutiveDeficitWeeks: 0,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    const applySpy = vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(TEST_DATE);

    expect(result.adjustmentReason).toBe('baseline locked');
    expect(result.adherenceFlag).toBeNull();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('skips predicted TDEE (and the comparison) when lean mass is not yet known', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue({
      weightKg: 80,
      ratePctPerWeek: 0.5,
      currentTargetKcal: 2500,
      leanMassKg: null,
      kcalFloor: null,
      baselineStartedAt: null,
      lastAdjustmentDate: '1999-05-01',
      consecutiveDeficitWeeks: 0,
    });
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue({ avgKcal: 400 });
    vi.spyOn(profileLib, 'applyRecomputeToProfile').mockResolvedValue();

    const result = await runDailyRecompute(TEST_DATE);

    expect(result.predictedTdeeKcal).toBeNull();
    expect(result.observedTdeeKcal).toBeCloseTo(2900, 5); // still computable, independent of lean mass
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dailyRecompute.test.ts`
Expected: FAIL with "Cannot find module '../lib/dailyRecompute.js'" (the fixture-setup test itself will pass once run in isolation, but import failure fails the whole file)

- [ ] **Step 3: Implement `lib/dailyRecompute.ts`**

```typescript
import { prisma } from './db.js';
import { addDays, weekdayOf } from './dateUtils.js';
import { fourteenDayAverageKcal, sevenDayAverageWeight, type DailyIntake } from './calc/rolling.js';
import { predictedTdee, observedTdee, tdeeComparison, BASE_ACTIVITY_FACTOR } from './calc/tdee.js';
import { isBaselineLocked, isStagnating, needsScheduledDietBreak, type WeeklyWeightPoint } from './calc/baseline.js';
import { computeAdjustment } from './calc/adjust.js';
import { getProfileSnapshot, applyRecomputeToProfile } from './profile.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import type { MealItem } from './meals.js';

export interface DailyRecomputeResult {
  date: string;
  totalKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  weightKg: number | null;
  rolling7Weight: number | null;
  rolling14Kcal: number | null;
  observedTdeeKcal: number | null;
  predictedTdeeKcal: number | null;
  targetKcal: number | null;
  isExcluded: boolean;
  adherenceFlag: boolean | null;
  adjustmentReason: string | null;
  dietBreakRecommended: boolean;
  stagnating: boolean;
}

function centeredWeights(weightByDate: Map<string, number>, centerDate: string): number[] {
  const values: number[] = [];
  for (let offset = -3; offset <= 3; offset++) {
    const value = weightByDate.get(addDays(centerDate, offset));
    if (value !== undefined) values.push(value);
  }
  return values;
}

function buildWeeklyWeightPoints(weightByDate: Map<string, number>, today: string): WeeklyWeightPoint[] {
  const points: WeeklyWeightPoint[] = [];
  for (let weeksAgo = 3; weeksAgo >= 0; weeksAgo--) {
    const weekStartDate = addDays(today, -7 * weeksAgo - 6);
    const values: number[] = [];
    for (let offset = 0; offset <= 6; offset++) {
      const value = weightByDate.get(addDays(weekStartDate, offset));
      if (value !== undefined) values.push(value);
    }
    if (values.length > 0) {
      points.push({ weekStartDate, avgWeightKg: values.reduce((s, v) => s + v, 0) / values.length });
    }
  }
  return points;
}

export async function runDailyRecompute(date: string): Promise<DailyRecomputeResult> {
  const windowStart = addDays(date, -13);
  const dayStart = new Date(`${windowStart}T00:00:00Z`);
  const dayEndExclusive = new Date(`${addDays(date, 1)}T00:00:00Z`);

  const [meals, dayPlans, weights, weeklyDefault, profile] = await Promise.all([
    prisma.meal.findMany({ where: { datetime: { gte: dayStart, lt: dayEndExclusive } } }),
    prisma.dayPlan.findMany({ where: { date: { gte: windowStart, lte: date } } }),
    prisma.weight.findMany({ where: { date: { gte: addDays(date, -20), lte: addDays(date, 3) } } }),
    getWeeklyDefault(weekdayOf(date)),
    getProfileSnapshot(),
  ]);

  const kcalByDate = new Map<string, number>();
  const macrosByDate = new Map<string, { proteinG: number; carbsG: number; fatG: number }>();
  for (const meal of meals) {
    const day = meal.datetime.toLocaleDateString('en-CA');
    kcalByDate.set(day, (kcalByDate.get(day) ?? 0) + meal.kcalMid);
    const items = meal.items as unknown as MealItem[];
    const macros = macrosByDate.get(day) ?? { proteinG: 0, carbsG: 0, fatG: 0 };
    for (const item of items) {
      macros.proteinG += item.proteinG;
      macros.carbsG += item.carbsG;
      macros.fatG += item.fatG;
    }
    macrosByDate.set(day, macros);
  }

  const isAtypicalByDate = new Map(dayPlans.map((p) => [p.date, p.isAtypical]));
  const weightByDate = new Map(weights.map((w) => [w.date, w.weightKg]));

  const intakes: DailyIntake[] = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(date, -13 + i);
    const kcal = kcalByDate.get(day);
    if (kcal !== undefined) {
      intakes.push({ date: day, kcal, isAtypical: isAtypicalByDate.get(day) ?? false });
    }
  }
  const rolling14Kcal = intakes.length > 0 ? fourteenDayAverageKcal(intakes) : null;

  const startWindow = centeredWeights(weightByDate, addDays(date, -14));
  const endWindow = centeredWeights(weightByDate, date);
  const weightStart = startWindow.length > 0 ? sevenDayAverageWeight(startWindow) : null;
  const weightEnd = endWindow.length > 0 ? sevenDayAverageWeight(endWindow) : null;

  const observedTdeeKcal =
    rolling14Kcal !== null && weightStart !== null && weightEnd !== null
      ? observedTdee(rolling14Kcal, weightStart, weightEnd)
      : null;

  const predictedTdeeKcal =
    profile.leanMassKg !== null
      ? predictedTdee({
          leanMassKg: profile.leanMassKg,
          activityFactor: BASE_ACTIVITY_FACTOR,
          plannedSegmentsKcal: weeklyDefault?.avgKcal ?? 0,
        })
      : null;

  if (predictedTdeeKcal !== null && observedTdeeKcal !== null) {
    const comparison = tdeeComparison(predictedTdeeKcal, observedTdeeKcal);
    await prisma.tdeeComparison.upsert({
      where: { date },
      create: { date, predicted: comparison.predicted, observed: comparison.observed, deltaPct: comparison.deltaPct },
      update: { predicted: comparison.predicted, observed: comparison.observed, deltaPct: comparison.deltaPct },
    });
  }

  let targetKcal = profile.currentTargetKcal;
  let adherenceFlag: boolean | null = null;
  let adjustmentReason: string | null = null;
  let dietBreakRecommended = false;
  let stagnating = false;

  if (
    targetKcal !== null &&
    profile.kcalFloor !== null &&
    profile.weightKg !== null &&
    profile.ratePctPerWeek !== null &&
    observedTdeeKcal !== null &&
    weightStart !== null &&
    weightEnd !== null
  ) {
    const baselineLocked = profile.baselineStartedAt !== null && isBaselineLocked(profile.baselineStartedAt, date);
    const targetRateKgPerWeek = (profile.ratePctPerWeek / 100) * profile.weightKg;
    const observedRateKgPerWeek = ((weightStart - weightEnd) / 14) * 7;

    const result = computeAdjustment({
      currentTargetKcal: targetKcal,
      targetRateKgPerWeek,
      observedRateKgPerWeek,
      kcalFloor: profile.kcalFloor,
      isBaselineLocked: baselineLocked,
      lastAdjustmentDate: profile.lastAdjustmentDate,
      today: date,
    });

    adjustmentReason = result.reason;
    const evaluatedThisWeek = result.reason !== 'baseline locked' && result.reason !== 'already adjusted this week';
    adherenceFlag = evaluatedThisWeek ? result.reason === 'within tolerance' : null;

    if (evaluatedThisWeek) {
      const weeklyPoints = buildWeeklyWeightPoints(weightByDate, date);
      stagnating = isStagnating(weeklyPoints);
      dietBreakRecommended = stagnating || needsScheduledDietBreak(profile.consecutiveDeficitWeeks);

      let finalTargetKcal = result.newTargetKcal;
      if (dietBreakRecommended) {
        finalTargetKcal = Math.max(finalTargetKcal, observedTdeeKcal);
      }

      const nextConsecutiveDeficitWeeks = dietBreakRecommended ? 0 : profile.consecutiveDeficitWeeks + 1;

      if (finalTargetKcal !== profile.currentTargetKcal || dietBreakRecommended) {
        await applyRecomputeToProfile({
          currentTargetKcal: finalTargetKcal,
          lastAdjustmentDate: date,
          consecutiveDeficitWeeks: nextConsecutiveDeficitWeeks,
        });
      }

      targetKcal = finalTargetKcal;
    }
  }

  const todayMacros = macrosByDate.get(date) ?? { proteinG: 0, carbsG: 0, fatG: 0 };
  const totalKcal = kcalByDate.get(date) ?? 0;
  const isExcluded = isAtypicalByDate.get(date) ?? false;
  const weightKgToday = weightByDate.get(date) ?? null;

  await prisma.dailyState.upsert({
    where: { date },
    create: {
      date,
      totalKcal,
      proteinG: todayMacros.proteinG,
      carbsG: todayMacros.carbsG,
      fatG: todayMacros.fatG,
      weightKg: weightKgToday,
      rolling7Weight: weightEnd,
      rolling14Kcal,
      observedTdee: observedTdeeKcal,
      predictedTdee: predictedTdeeKcal,
      targetKcal,
      isExcluded,
      adherenceFlag,
    },
    update: {
      totalKcal,
      proteinG: todayMacros.proteinG,
      carbsG: todayMacros.carbsG,
      fatG: todayMacros.fatG,
      weightKg: weightKgToday,
      rolling7Weight: weightEnd,
      rolling14Kcal,
      observedTdee: observedTdeeKcal,
      predictedTdee: predictedTdeeKcal,
      targetKcal,
      isExcluded,
      adherenceFlag,
    },
  });

  return {
    date,
    totalKcal,
    proteinG: todayMacros.proteinG,
    carbsG: todayMacros.carbsG,
    fatG: todayMacros.fatG,
    weightKg: weightKgToday,
    rolling7Weight: weightEnd,
    rolling14Kcal,
    observedTdeeKcal,
    predictedTdeeKcal,
    targetKcal,
    isExcluded,
    adherenceFlag,
    adjustmentReason,
    dietBreakRecommended,
    stagnating,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dailyRecompute.test.ts`
Expected: PASS (4 tests, in order — the fixture-setup test must run first)

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add lib/dailyRecompute.ts tests/dailyRecompute.test.ts
git commit -m "feat: add runDailyRecompute orchestration (dual TDEE, weekly adjustment, diet-break)"
```

---

### Task 8: Cron route + webhook wiring

**Files:**
- Create: `api/cron/daily-recompute.ts`
- Create: `tests/cron-daily-recompute.test.ts`
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `runDailyRecompute` (`lib/dailyRecompute.js`), `addDays` (`lib/dateUtils.js`), `SET_BODY_SCAN_TOOL`/`handleSetBodyScanTool` (`lib/bodyScan.js`), `TRIGGER_REBASELINE_TOOL`/`handleTriggerRebaselineTool` (`lib/rebaseline.js`).

- [ ] **Step 1: Write the failing test for the route**

Create `tests/cron-daily-recompute.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dailyRecomputeLib from '../lib/dailyRecompute.js';

const handler = (await import('../api/cron/daily-recompute.js')).default;

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

describe('GET /api/cron/daily-recompute', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
  });

  it('rejects requests without the correct bearer token', async () => {
    const res = mockRes();
    await handler({ headers: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('runs the recompute for yesterday and returns the result when authorized', async () => {
    const spy = vi
      .spyOn(dailyRecomputeLib, 'runDailyRecompute')
      .mockResolvedValue({ date: '2026-01-01' } as any);

    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer test-secret' } } as any, res as any);

    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron-daily-recompute.test.ts`
Expected: FAIL with "Cannot find module '../api/cron/daily-recompute.js'"

- [ ] **Step 3: Implement `api/cron/daily-recompute.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runDailyRecompute } from '../../lib/dailyRecompute.js';
import { addDays } from '../../lib/dateUtils.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end();
    return;
  }

  const todayIso = new Date().toLocaleDateString('en-CA');
  const yesterday = addDays(todayIso, -1);
  const result = await runDailyRecompute(yesterday);

  res.status(200).json(result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cron-daily-recompute.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Update the failing webhook test**

In `tests/webhook.test.ts`, update the import line and the expected tools array (same pattern as the previous `LOG_WEIGHED_MEAL_TOOL` addition):

```typescript
import { SET_BODY_SCAN_TOOL } from '../lib/bodyScan.js';
import { TRIGGER_REBASELINE_TOOL } from '../lib/rebaseline.js';
```

Change the tools array in the first `it("responds 200 and replies...")` test to:

```typescript
      [
        ...scenariosLib.SCENARIO_TOOLS,
        SET_WEEKLY_SCHEDULE_TOOL,
        LOG_WEIGHT_TOOL,
        LOG_MEAL_TOOL,
        LOG_WEIGHED_MEAL_TOOL,
        SET_BODY_SCAN_TOOL,
        TRIGGER_REBASELINE_TOOL,
        FLAG_CONCERN_TOOL,
      ],
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — actual tools array doesn't include the two new tools yet.

- [ ] **Step 7: Wire the tools into `api/telegram/webhook.ts`**

Add imports:

```typescript
import { SET_BODY_SCAN_TOOL, handleSetBodyScanTool } from '../../lib/bodyScan.js';
import { TRIGGER_REBASELINE_TOOL, handleTriggerRebaselineTool } from '../../lib/rebaseline.js';
```

Update `GENERAL_CHAT_TOOLS`:

```typescript
const GENERAL_CHAT_TOOLS = [
  ...SCENARIO_TOOLS,
  SET_WEEKLY_SCHEDULE_TOOL,
  LOG_WEIGHT_TOOL,
  LOG_MEAL_TOOL,
  LOG_WEIGHED_MEAL_TOOL,
  SET_BODY_SCAN_TOOL,
  TRIGGER_REBASELINE_TOOL,
  FLAG_CONCERN_TOOL,
];
```

Update `handleGeneralChatTool`:

```typescript
async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  if (name === 'log_weighed_meal') return handleLogWeighedMealTool(input);
  if (name === 'set_body_scan') return handleSetBodyScanTool(input);
  if (name === 'trigger_rebaseline') return handleTriggerRebaselineTool(input);
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS

- [ ] **Step 9: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 10: Commit**

```bash
git add api/cron/daily-recompute.ts tests/cron-daily-recompute.test.ts api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: add daily-recompute cron route, wire set_body_scan/trigger_rebaseline into webhook"
```

---

### Task 9: Env vars, GitHub Actions schedule, README

**Files:**
- Modify: `.env.example`
- Modify: `.env` (not committed — gitignored)
- Create: `.github/workflows/daily-recompute.yml`
- Modify: `README.md`

- [ ] **Step 1: Add `CRON_SECRET` and `TZ` to `.env.example`**

```
DATABASE_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
CRON_SECRET=
TZ=Europe/Zurich
```

- [ ] **Step 2: Generate a real `CRON_SECRET` and add both vars to the local `.env`**

Run (prints nothing sensitive — writes directly to `.env`):

```bash
node -e "require('fs').appendFileSync('.env', '\nCRON_SECRET=' + require('crypto').randomBytes(32).toString('base64url') + '\nTZ=Europe/Zurich\n')"
```

- [ ] **Step 3: Create `.github/workflows/daily-recompute.yml`**

```yaml
name: Daily recompute

on:
  schedule:
    - cron: '0 4 * * *'
  workflow_dispatch:

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Call daily-recompute endpoint
        run: |
          curl -sf -X GET "${{ secrets.RECOMPUTE_URL }}" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

- [ ] **Step 4: Note the manual GitHub setup step**

This workflow needs two repo secrets that can't be set from code — add a short section to `README.md` after the existing "Deploying the webhook" section:

```markdown
## Daily recompute cron (step 8)

`/api/cron/daily-recompute` recomputes yesterday's TDEE estimates and adjusts `currentTargetKcal`. It's triggered by `.github/workflows/daily-recompute.yml`, which needs two repo secrets set manually (GitHub → Settings → Secrets and variables → Actions):

- `RECOMPUTE_URL` — `https://<your-vercel-domain>/api/cron/daily-recompute`
- `CRON_SECRET` — same value as the `CRON_SECRET` env var set in Vercel

Until `ANTHROPIC_API_KEY` is available and the project is deployed, this route exists but isn't reachable in production yet.
```

- [ ] **Step 5: Typecheck (confirms nothing broke)**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 6: Commit and push**

```bash
git add .env.example .github/workflows/daily-recompute.yml README.md
git commit -m "feat: add CRON_SECRET/TZ env vars, daily-recompute GitHub Actions schedule"
git push
```

---

## Self-Review Notes

- **Spec coverage:** §5 (dual TDEE, side-by-side, delta tracked) → `tdeeComparison` + `TdeeComparison` persistence in Task 7. §6 adaptation loop → `computeAdjustment` wiring in Task 7. §6 re-baseline → Task 6. §6 diet break (stagnation + scheduled) → Task 7's `dietBreakRecommended` branch. §11 data model → `BodyScan`/`DailyState`/`TdeeComparison` in Task 1. §14 step 8 file layout (`/api/cron/daily-recompute.ts`) → Task 8. Explicitly NOT covered (see Global Constraints): performance-decline alert, sleep-gating, rest-day guardrail, and any outbound notification message — all need data sources or a step-9 surface this plan doesn't build.
- **Type consistency:** `ProfileSnapshot` (Task 4) field names match exactly what `handleSetBodyScanTool` (Task 5) and `runDailyRecompute` (Task 7) read from it. `getWeeklyDefault`'s `{ avgKcal: number } | null` return (Task 5) matches both consumers' usage (`weeklyDefault?.avgKcal ?? 0`).
- **Testing-safety rule applied consistently:** `Profile` writes (Task 4) — no test file. `WeeklyDefault` — wrapped behind `getWeeklyDefault`, mocked everywhere, never touched live even for reads. `BodyScan`/`DailyState`/`TdeeComparison`/`Weight`/`Meal`/`DayPlan` — accumulating, live-tested with historical fixed dates (`1999-*`) and `afterAll` cleanup, matching the existing `tests/weight.test.ts` convention.
