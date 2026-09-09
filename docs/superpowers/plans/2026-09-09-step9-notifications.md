# Step 9 — Notifications (`/api/cron/tick`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `POST /api/cron/tick` route from spec §9 — a 15-minute cron that sends anti-spammed, conditional Telegram nudges (day-plan prompt, weekly weigh-in, weekly review, no-meal-24h, diet-break proposal) using the data step 8 already computes and persists.

**Architecture:** Deterministic, template-based rules — **no Claude API call anywhere in this route**, which is a deliberate choice: it means step 9 is fully testable and even deployable/triggerable today without `ANTHROPIC_API_KEY`, unlike every conversational feature built so far. `lib/notificationRules.ts` holds pure `(context) => {rule, message} | null` functions (mirrors `/lib/calc`'s pure-function philosophy for this domain). `lib/notificationTick.ts` gathers the data, applies anti-spam gating, and calls `sendMessage`. A new `Notification` collection tracks what fired today.

**Tech Stack:** Same as the rest of the project (Node/TS ESM, Prisma/MongoDB, Vitest, `@vercel/node`).

**Spec:** `docs/spec-agent-nutrition-v4.md` §9 (notifications table, anti-spam rules), §14 step 9.

## Global Constraints

- **Anti-spam, exactly per spec**: max 4 notifications/day, nothing between 22:00–07:00 Europe/Zurich, a rule never fires twice the same (Zurich-local) day, every notification is conditional (already-satisfied condition → nothing sent). All three are enforced in `runNotificationTick`, not left to chance.
- **Zurich time is computed explicitly via `timeZone: 'Europe/Zurich'` on every `Date` formatting call** in this plan, rather than relying on `process.env.TZ` (set in step 8, but only guaranteed on Vercel/the cron trigger — not on a local dev machine or a differently-configured CI runner). This makes the quiet-hours and "today" logic correct regardless of the runtime's own timezone.
- **Two rules explicitly deferred — same "no data source yet" reasoning as step 8's deferrals**:
  - *Collation pré-séance* (snack before a session in 45–105 min) — `Segment.timing` (`lib/scenarios.ts`) is freeform text ("matin", "12h30", "après le boulot"), not a parseable clock time. Building a reliable "is a session starting in 45–105 minutes" check needs structured segment timing, which doesn't exist. Flagging this rather than guess-parsing free text into false "sessions coming up."
  - *Alerte performance* (2 weeks of declining performance) — needs workout/performance metric logging (spec's `performance` table), which hasn't been built.
- **The "nuit ?" one-tap (bonne/moyenne/mauvaise) piece of the "Plan du jour" rule is also deferred**: a real one-tap needs Telegram inline keyboards + `callback_query` update handling, neither of which exist in `lib/telegram.ts` yet (it only does plain `sendMessage`/text `parseUpdate`). Building that is a separate, self-contained piece of work (and the natural moment to also add a `log_sleep` tool, closing the gap already noted in step 8 that `blocksDownwardAdjustmentFromSleep` has no data feed). This plan sends the day-plan prompt as **plain text only**, without the sleep question.
- **`DailyState` needs one new field** (`dietBreakRecommended: Boolean`) that `runDailyRecompute` (step 8) computes but never persisted — a real gap discovered while building this plan, fixed in Task 1 alongside the new `Notification` model.
- **Test-isolation lesson applied from step 8's fixture-collision bug**: `getMostRecentMeal()`/`getMostRecentDailyState()` (needed for the "no meal in 24h" and "weekly review" rules) are intentionally **unbounded "most recent" queries with no date filter** — that's correct for production (mono-user, there's only ever one real timeline), but makes them untestable with a live fixture (any other test file's live-written row with a later date would silently win the "most recent" race under parallel test execution). Both are wrapped in `lib/notificationStore.ts` and **mocked via `vi.spyOn` in every test**, never touched live — same pattern as `WeeklyDefault`'s `getWeeklyDefault` in step 8. The exact-date lookups (`Weight`/`DayPlan`/`Notification` for a specific day) have no such risk and are live-tested with a fresh historical date (`1999-09-*`, checked via `grep '1999-\d\d-\d\d' tests/` against every existing fixture before picking it — nothing else in the suite uses September 1999).
- **Morning/evening windows are a judgment call, documented like `BASE_ACTIVITY_FACTOR` in step 8**: spec says "matin"/"soir" without exact hours. This plan uses 07:00–11:00 for morning, 18:00–22:00 for evening (Europe/Zurich) — reasonable, adjustable later, not spec-mandated numbers.

---

### Task 1: `Notification` model, `DailyState.dietBreakRecommended`, `ProfileSnapshot.weighInDay`/`reviewDay`

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `lib/dailyRecompute.ts` (persist the new field)
- Modify: `tests/dailyRecompute.test.ts` (assert the new field)
- Modify: `lib/profile.ts` (extend `ProfileSnapshot`)

**Interfaces:**
- Produces: `Notification` model (`date`, `rule`, `sentAt`, `@@unique([date, rule])`); `DailyState.dietBreakRecommended: Boolean`; `ProfileSnapshot.weighInDay: string | null`, `ProfileSnapshot.reviewDay: string | null`.

- [ ] **Step 1: Add the `Notification` model and the `DailyState` field**

In `prisma/schema.prisma`, add `dietBreakRecommended Boolean @default(false)` to the existing `DailyState` model (after `adherenceFlag`), and append a new model at the end of the file:

```prisma
model Notification {
  id     String   @id @default(auto()) @map("_id") @db.ObjectId
  date   String
  rule   String
  sentAt DateTime @default(now())

  @@unique([date, rule])
}
```

- [ ] **Step 2: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 3: Persist `dietBreakRecommended` in `runDailyRecompute`**

In `lib/dailyRecompute.ts`, add `dietBreakRecommended` to both the `create` and `update` blocks of the `prisma.dailyState.upsert(...)` call (the variable already exists in scope from the adjustment block above it):

```typescript
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
      dietBreakRecommended,
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
      dietBreakRecommended,
    },
```

- [ ] **Step 4: Add a test assertion for the persisted field**

In `tests/dailyRecompute.test.ts`, in the `'computes both TDEE estimates...'` test, add this line right after the existing `expect(dailyState?.isExcluded).toBe(false);`:

```typescript
    expect(dailyState?.dietBreakRecommended).toBe(false);
```

- [ ] **Step 5: Extend `ProfileSnapshot` in `lib/profile.ts`**

Add `weighInDay: string | null;` and `reviewDay: string | null;` to the `ProfileSnapshot` interface, and the corresponding lines to `getProfileSnapshot()`:

```typescript
    weighInDay: profile?.weighInDay ?? null,
    reviewDay: profile?.reviewDay ?? null,
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma lib/dailyRecompute.ts tests/dailyRecompute.test.ts lib/profile.ts
git commit -m "feat: add Notification model, persist dietBreakRecommended, extend ProfileSnapshot"
```

---

### Task 2: `lib/notificationStore.ts`

**Files:**
- Create: `lib/notificationStore.ts`
- Test: `tests/notificationStore.test.ts`

**Interfaces:**
- Produces: `countNotificationsToday(date): Promise<number>`, `hasRuleFiredToday(date, rule): Promise<boolean>`, `recordNotificationSent(date, rule): Promise<void>`, `getMostRecentMeal(): Promise<{ datetime: Date } | null>`, `getMostRecentDailyState(): Promise<{ date, observedTdee, predictedTdee, targetKcal, adherenceFlag, dietBreakRecommended } | null>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notificationStore.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { countNotificationsToday, hasRuleFiredToday, recordNotificationSent } from '../lib/notificationStore.js';

const TEST_DATE = '1999-09-10';

describe('notificationStore', () => {
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { date: TEST_DATE } });
  });

  it('starts at zero sent and no rule fired', async () => {
    expect(await countNotificationsToday(TEST_DATE)).toBe(0);
    expect(await hasRuleFiredToday(TEST_DATE, 'no_meal_24h')).toBe(false);
  });

  it('records a sent notification, reflected in both the count and the per-rule check', async () => {
    await recordNotificationSent(TEST_DATE, 'no_meal_24h');

    expect(await countNotificationsToday(TEST_DATE)).toBe(1);
    expect(await hasRuleFiredToday(TEST_DATE, 'no_meal_24h')).toBe(true);
    expect(await hasRuleFiredToday(TEST_DATE, 'weekly_weigh_in')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/notificationStore.test.ts`
Expected: FAIL with "Cannot find module '../lib/notificationStore.js'"

- [ ] **Step 3: Implement `lib/notificationStore.ts`**

```typescript
import { prisma } from './db.js';

export async function countNotificationsToday(date: string): Promise<number> {
  return prisma.notification.count({ where: { date } });
}

export async function hasRuleFiredToday(date: string, rule: string): Promise<boolean> {
  const existing = await prisma.notification.findUnique({ where: { date_rule: { date, rule } } });
  return existing !== null;
}

export async function recordNotificationSent(date: string, rule: string): Promise<void> {
  await prisma.notification.create({ data: { date, rule } });
}

export interface RecentMeal {
  datetime: Date;
}

export async function getMostRecentMeal(): Promise<RecentMeal | null> {
  const meal = await prisma.meal.findFirst({ orderBy: { datetime: 'desc' } });
  return meal ? { datetime: meal.datetime } : null;
}

export interface RecentDailyState {
  date: string;
  observedTdee: number | null;
  predictedTdee: number | null;
  targetKcal: number | null;
  adherenceFlag: boolean | null;
  dietBreakRecommended: boolean;
}

export async function getMostRecentDailyState(): Promise<RecentDailyState | null> {
  const state = await prisma.dailyState.findFirst({ orderBy: { date: 'desc' } });
  return state
    ? {
        date: state.date,
        observedTdee: state.observedTdee,
        predictedTdee: state.predictedTdee,
        targetKcal: state.targetKcal,
        adherenceFlag: state.adherenceFlag,
        dietBreakRecommended: state.dietBreakRecommended,
      }
    : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/notificationStore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/notificationStore.ts tests/notificationStore.test.ts
git commit -m "feat: add notificationStore (anti-spam tracking + most-recent-meal/daily-state lookups)"
```

---

### Task 3: `lib/notificationRules.ts` — pure rule functions

**Files:**
- Create: `lib/notificationRules.ts`
- Test: `tests/notificationRules.test.ts`

**Interfaces:**
- Consumes: `Weekday` type (`lib/weeklySchedule.js`).
- Produces: `NotificationContext` interface, `NotificationRuleResult` interface, `ruleDayPlanPrompt`, `ruleWeeklyWeighIn`, `ruleWeeklyReview`, `ruleDietBreak`, `ruleNoMealIn24h` (each `(ctx: NotificationContext) => NotificationRuleResult | null`), `NOTIFICATION_RULES: Array<(ctx) => NotificationRuleResult | null>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notificationRules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  ruleDayPlanPrompt,
  ruleWeeklyWeighIn,
  ruleWeeklyReview,
  ruleDietBreak,
  ruleNoMealIn24h,
} from '../lib/notificationRules.js';
import type { NotificationContext } from '../lib/notificationRules.js';

const baseCtx: NotificationContext = {
  dateIso: '2026-09-09',
  hourLocal: 8,
  weekday: 'wednesday',
  weighInDay: null,
  reviewDay: null,
  todayWeightLogged: false,
  latestMealAgeHours: 2,
  todayDayPlanConfirmed: true,
  todayWeekdayActivityHint: null,
  latestDailyState: null,
  currentTargetKcal: null,
};

describe('ruleDayPlanPrompt', () => {
  it('fires in the morning when the day plan is not confirmed', () => {
    const result = ruleDayPlanPrompt({ ...baseCtx, todayDayPlanConfirmed: false });
    expect(result?.rule).toBe('day_plan_prompt');
  });

  it('includes the weekly-default activity hint when known', () => {
    const result = ruleDayPlanPrompt({
      ...baseCtx,
      todayDayPlanConfirmed: false,
      todayWeekdayActivityHint: 'course facile',
    });
    expect(result?.message).toContain('course facile');
  });

  it('does not fire outside the morning window', () => {
    expect(ruleDayPlanPrompt({ ...baseCtx, hourLocal: 15, todayDayPlanConfirmed: false })).toBeNull();
  });

  it('does not fire once the day plan is confirmed', () => {
    expect(ruleDayPlanPrompt({ ...baseCtx, todayDayPlanConfirmed: true })).toBeNull();
  });
});

describe('ruleWeeklyWeighIn', () => {
  it('fires in the morning on the weigh-in day when no weight is logged yet', () => {
    const result = ruleWeeklyWeighIn({ ...baseCtx, weighInDay: 'wednesday', todayWeightLogged: false });
    expect(result?.rule).toBe('weekly_weigh_in');
  });

  it('does not fire on a different weekday', () => {
    expect(ruleWeeklyWeighIn({ ...baseCtx, weighInDay: 'monday' })).toBeNull();
  });

  it('does not fire once already weighed in today', () => {
    expect(ruleWeeklyWeighIn({ ...baseCtx, weighInDay: 'wednesday', todayWeightLogged: true })).toBeNull();
  });
});

describe('ruleWeeklyReview', () => {
  const dailyState = {
    date: '2026-09-08',
    observedTdee: 2900,
    predictedTdee: 2800,
    targetKcal: 2600,
    adherenceFlag: true,
    dietBreakRecommended: false,
  };

  it('fires in the evening on the review day with computed data available', () => {
    const result = ruleWeeklyReview({
      ...baseCtx,
      hourLocal: 19,
      reviewDay: 'wednesday',
      latestDailyState: dailyState,
    });
    expect(result?.rule).toBe('weekly_review');
    expect(result?.message).toContain('2900');
    expect(result?.message).toContain('2600');
  });

  it('does not fire without any computed daily state yet', () => {
    expect(ruleWeeklyReview({ ...baseCtx, hourLocal: 19, reviewDay: 'wednesday', latestDailyState: null })).toBeNull();
  });

  it('does not fire outside the evening window', () => {
    expect(
      ruleWeeklyReview({ ...baseCtx, hourLocal: 9, reviewDay: 'wednesday', latestDailyState: dailyState })
    ).toBeNull();
  });
});

describe('ruleDietBreak', () => {
  it('fires when the most recent daily state recommends a diet break', () => {
    const result = ruleDietBreak({
      ...baseCtx,
      latestDailyState: {
        date: '2026-09-08',
        observedTdee: 2900,
        predictedTdee: 2800,
        targetKcal: 2900,
        adherenceFlag: null,
        dietBreakRecommended: true,
      },
    });
    expect(result?.rule).toBe('diet_break');
    expect(result?.message).toContain('1 à 2 kg');
  });

  it('does not fire otherwise', () => {
    expect(ruleDietBreak({ ...baseCtx, latestDailyState: null })).toBeNull();
  });
});

describe('ruleNoMealIn24h', () => {
  it('fires when no meal has ever been logged', () => {
    expect(ruleNoMealIn24h({ ...baseCtx, latestMealAgeHours: null })?.rule).toBe('no_meal_24h');
  });

  it('fires when the last meal was over 24h ago', () => {
    expect(ruleNoMealIn24h({ ...baseCtx, latestMealAgeHours: 25 })?.rule).toBe('no_meal_24h');
  });

  it('does not fire within 24h of the last meal', () => {
    expect(ruleNoMealIn24h({ ...baseCtx, latestMealAgeHours: 5 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/notificationRules.test.ts`
Expected: FAIL with "Cannot find module '../lib/notificationRules.js'"

- [ ] **Step 3: Implement `lib/notificationRules.ts`**

```typescript
import type { Weekday } from './weeklySchedule.js';

export interface NotificationContext {
  dateIso: string;
  hourLocal: number;
  weekday: Weekday;
  weighInDay: string | null;
  reviewDay: string | null;
  todayWeightLogged: boolean;
  latestMealAgeHours: number | null;
  todayDayPlanConfirmed: boolean;
  todayWeekdayActivityHint: string | null;
  latestDailyState: {
    date: string;
    observedTdee: number | null;
    predictedTdee: number | null;
    targetKcal: number | null;
    adherenceFlag: boolean | null;
    dietBreakRecommended: boolean;
  } | null;
  currentTargetKcal: number | null;
}

export interface NotificationRuleResult {
  rule: string;
  message: string;
}

const MORNING_START_HOUR = 7;
const MORNING_END_HOUR = 11;
const EVENING_START_HOUR = 18;
const EVENING_END_HOUR = 22;
const STALE_MEAL_HOURS = 24;

function isMorning(hourLocal: number): boolean {
  return hourLocal >= MORNING_START_HOUR && hourLocal < MORNING_END_HOUR;
}

function isEvening(hourLocal: number): boolean {
  return hourLocal >= EVENING_START_HOUR && hourLocal < EVENING_END_HOUR;
}

export function ruleNoMealIn24h(ctx: NotificationContext): NotificationRuleResult | null {
  if (ctx.latestMealAgeHours === null || ctx.latestMealAgeHours > STALE_MEAL_HOURS) {
    return {
      rule: 'no_meal_24h',
      message: 'Pas de repas noté depuis plus de 24h — pense à enregistrer ce que tu manges quand tu peux.',
    };
  }
  return null;
}

export function ruleWeeklyWeighIn(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isMorning(ctx.hourLocal)) return null;
  if (ctx.weighInDay !== ctx.weekday) return null;
  if (ctx.todayWeightLogged) return null;
  return {
    rule: 'weekly_weigh_in',
    message:
      "C'est le jour de pesée. Pèse-toi à jeun, après être passé aux toilettes, avant de boire quoi que ce soit, puis note le résultat.",
  };
}

export function ruleDayPlanPrompt(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isMorning(ctx.hourLocal)) return null;
  if (ctx.todayDayPlanConfirmed) return null;
  const hint = ctx.todayWeekdayActivityHint ? ` (probablement : ${ctx.todayWeekdayActivityHint})` : '';
  return {
    rule: 'day_plan_prompt',
    message: `Qu'est-ce que tu as prévu aujourd'hui ?${hint}`,
  };
}

export function ruleWeeklyReview(ctx: NotificationContext): NotificationRuleResult | null {
  if (!isEvening(ctx.hourLocal)) return null;
  if (ctx.reviewDay !== ctx.weekday) return null;
  if (!ctx.latestDailyState || ctx.latestDailyState.observedTdee === null) return null;

  const s = ctx.latestDailyState;
  const adherenceText =
    s.adherenceFlag === true ? 'dans la tolérance' : s.adherenceFlag === false ? 'hors tolérance' : 'pas encore évalué';
  const parts = [
    `Bilan de la semaine : TDEE observé ${s.observedTdee?.toFixed(0)} kcal`,
    s.predictedTdee !== null ? `vs prédit ${s.predictedTdee.toFixed(0)} kcal` : null,
    `cible actuelle ${s.targetKcal?.toFixed(0)} kcal`,
    `ajustement ${adherenceText}.`,
  ].filter((part): part is string => part !== null);

  return { rule: 'weekly_review', message: parts.join(', ') };
}

export function ruleDietBreak(ctx: NotificationContext): NotificationRuleResult | null {
  if (!ctx.latestDailyState?.dietBreakRecommended) return null;
  return {
    rule: 'diet_break',
    message:
      'Palier haut proposé : on remonte à maintenance pour 7 jours, pas de baisse supplémentaire. Le poids peut remonter de 1 à 2 kg (glycogène et eau, pas de la graisse) et redescend en quelques jours.',
  };
}

export const NOTIFICATION_RULES = [
  ruleDayPlanPrompt,
  ruleWeeklyWeighIn,
  ruleWeeklyReview,
  ruleDietBreak,
  ruleNoMealIn24h,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/notificationRules.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/notificationRules.ts tests/notificationRules.test.ts
git commit -m "feat: add pure notification rule functions"
```

---

### Task 4: `lib/notificationTick.ts` — orchestration

**Files:**
- Create: `lib/notificationTick.ts`
- Test: `tests/notificationTick.test.ts`

**Interfaces:**
- Consumes: `sendMessage` (`lib/telegram.js`), `weekdayOf` (`lib/dateUtils.js`), `getProfileSnapshot` (`lib/profile.js`), `getWeeklyDefault` (`lib/weeklyScheduleStore.js`), `countNotificationsToday`/`hasRuleFiredToday`/`recordNotificationSent`/`getMostRecentMeal`/`getMostRecentDailyState` (`lib/notificationStore.js`), `NOTIFICATION_RULES`/`NotificationContext` (`lib/notificationRules.js`), `prisma` (`lib/db.js`).
- Produces: `TickResult` interface, `runNotificationTick(now: Date, chatId: number): Promise<TickResult>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notificationTick.test.ts`:

```typescript
import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { runNotificationTick } from '../lib/notificationTick.js';
import * as profileLib from '../lib/profile.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';
import * as notificationStoreLib from '../lib/notificationStore.js';
import * as telegramLib from '../lib/telegram.js';

const TEST_DATE = '1999-09-05';

function baseProfile() {
  return {
    weightKg: 80,
    ratePctPerWeek: 0.5,
    currentTargetKcal: 2600,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('runNotificationTick', () => {
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { date: TEST_DATE } });
    await prisma.dayPlan.deleteMany({ where: { date: TEST_DATE } });
    await prisma.weight.deleteMany({ where: { date: TEST_DATE } });
  });

  it('sends nothing and skips entirely during quiet hours', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    const result = await runNotificationTick(new Date('1999-09-05T23:30:00Z'), 12345);

    expect(result.skippedQuietHours).toBe(true);
    expect(result.sent).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends the day-plan prompt in the morning when nothing else is set up', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    // Europe/Zurich in September is UTC+2 (CEST); 08:00 UTC local time text below assumes this offset.
    const result = await runNotificationTick(new Date('1999-09-05T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toEqual(['day_plan_prompt']);
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining("prévu aujourd'hui"));

    const recorded = await prisma.notification.findUnique({
      where: { date_rule: { date: TEST_DATE, rule: 'day_plan_prompt' } },
    });
    expect(recorded).not.toBeNull();
  });

  it('does not fire the same rule twice on the same day', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    // day_plan_prompt already recorded by the previous test for this same TEST_DATE.
    const result = await runNotificationTick(new Date('1999-09-05T07:00:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).not.toContain('day_plan_prompt');
    expect(sendSpy).not.toHaveBeenCalledWith(12345, expect.stringContaining('prévu'));
  });

  it('stops once the daily cap is reached', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1999-09-05T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'countNotificationsToday').mockResolvedValue(4);
    const sendSpy = vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();

    const result = await runNotificationTick(new Date('1999-09-05T07:00:00Z'), 12345);

    expect(result.sent).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/notificationTick.test.ts`
Expected: FAIL with "Cannot find module '../lib/notificationTick.js'"

- [ ] **Step 3: Implement `lib/notificationTick.ts`**

```typescript
import { prisma } from './db.js';
import { sendMessage } from './telegram.js';
import { weekdayOf } from './dateUtils.js';
import { getProfileSnapshot } from './profile.js';
import { getWeeklyDefault } from './weeklyScheduleStore.js';
import {
  countNotificationsToday,
  hasRuleFiredToday,
  recordNotificationSent,
  getMostRecentMeal,
  getMostRecentDailyState,
} from './notificationStore.js';
import { NOTIFICATION_RULES } from './notificationRules.js';
import type { NotificationContext } from './notificationRules.js';

const MAX_NOTIFICATIONS_PER_DAY = 4;
const QUIET_HOUR_START = 22;
const QUIET_HOUR_END = 7;
const ZURICH_TZ = 'Europe/Zurich';

function zurichParts(now: Date): { dateIso: string; hourLocal: number } {
  const dateIso = now.toLocaleDateString('en-CA', { timeZone: ZURICH_TZ });
  const hourLocal = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: ZURICH_TZ }));
  return { dateIso, hourLocal };
}

export interface TickResult {
  sent: { rule: string; message: string }[];
  skippedQuietHours: boolean;
}

export async function runNotificationTick(now: Date, chatId: number): Promise<TickResult> {
  const { dateIso, hourLocal } = zurichParts(now);

  if (hourLocal >= QUIET_HOUR_START || hourLocal < QUIET_HOUR_END) {
    return { sent: [], skippedQuietHours: true };
  }

  let sentCount = await countNotificationsToday(dateIso);
  if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) {
    return { sent: [], skippedQuietHours: false };
  }

  const weekday = weekdayOf(dateIso);

  const [profile, weeklyDefault, todayWeight, todayDayPlan, latestMeal, latestDailyState] = await Promise.all([
    getProfileSnapshot(),
    getWeeklyDefault(weekday),
    prisma.weight.findUnique({ where: { date: dateIso } }),
    prisma.dayPlan.findUnique({ where: { date: dateIso } }),
    getMostRecentMeal(),
    getMostRecentDailyState(),
  ]);

  const latestMealAgeHours = latestMeal ? (now.getTime() - latestMeal.datetime.getTime()) / (1000 * 60 * 60) : null;

  const context: NotificationContext = {
    dateIso,
    hourLocal,
    weekday,
    weighInDay: profile.weighInDay,
    reviewDay: profile.reviewDay,
    todayWeightLogged: todayWeight !== null,
    latestMealAgeHours,
    todayDayPlanConfirmed: todayDayPlan?.confirmed ?? false,
    todayWeekdayActivityHint: weeklyDefault ? weeklyDefault.activityType : null,
    latestDailyState,
    currentTargetKcal: profile.currentTargetKcal,
  };

  const sent: { rule: string; message: string }[] = [];

  for (const rule of NOTIFICATION_RULES) {
    if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) break;
    const result = rule(context);
    if (!result) continue;
    if (await hasRuleFiredToday(dateIso, result.rule)) continue;

    await sendMessage(chatId, result.message);
    await recordNotificationSent(dateIso, result.rule);
    sent.push(result);
    sentCount++;
  }

  return { sent, skippedQuietHours: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/notificationTick.test.ts`
Expected: PASS (4 tests, in order)

- [ ] **Step 5: Typecheck + full suite (run at least twice to catch any date-fixture flakiness, per the step-8 lesson)**

Run: `npm run typecheck && npm test && npm test`
Expected: all PASS both times

- [ ] **Step 6: Commit**

```bash
git add lib/notificationTick.ts tests/notificationTick.test.ts
git commit -m "feat: add runNotificationTick orchestration (anti-spam gating + rule dispatch)"
```

---

### Task 5: Cron route + GitHub Actions schedule + README

**Files:**
- Create: `api/cron/tick.ts`
- Create: `tests/cron-tick.test.ts`
- Create: `.github/workflows/tick.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `runNotificationTick` (`lib/notificationTick.js`).

- [ ] **Step 1: Write the failing test**

Create `tests/cron-tick.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as notificationTickLib from '../lib/notificationTick.js';

const handler = (await import('../api/cron/tick.js')).default;

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

describe('GET /api/cron/tick', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    process.env.TELEGRAM_CHAT_ID = '12345';
  });

  it('rejects requests without the correct bearer token', async () => {
    const res = mockRes();
    await handler({ headers: {} } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('runs the tick and returns the result when authorized', async () => {
    const spy = vi
      .spyOn(notificationTickLib, 'runNotificationTick')
      .mockResolvedValue({ sent: [], skippedQuietHours: false });

    const res = mockRes();
    await handler({ headers: { authorization: 'Bearer test-secret' } } as any, res as any);

    expect(spy).toHaveBeenCalledWith(expect.any(Date), 12345);
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron-tick.test.ts`
Expected: FAIL with "Cannot find module '../api/cron/tick.js'"

- [ ] **Step 3: Implement `api/cron/tick.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runNotificationTick } from '../../lib/notificationTick.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end();
    return;
  }

  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  const result = await runNotificationTick(new Date(), chatId);

  res.status(200).json(result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cron-tick.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Create `.github/workflows/tick.yml`**

```yaml
name: Notification tick

on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Call tick endpoint
        run: |
          curl -sf -X GET "${{ secrets.TICK_URL }}" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

- [ ] **Step 6: Add the manual GitHub secret to `README.md`**

Append to the existing "Daily recompute cron (step 8)" section:

```markdown
## Notification tick (step 9)

`/api/cron/tick` runs every 15 minutes via `.github/workflows/tick.yml` and sends anti-spammed, conditional Telegram nudges (day-plan prompt, weekly weigh-in, weekly review, no-meal-24h reminder, diet-break proposal). It needs one more repo secret alongside `CRON_SECRET` (already set for step 8):

- `TICK_URL` — `https://<your-vercel-domain>/api/cron/tick`

Note: GitHub Actions scheduled workflows can run late under load — the spec already accounts for this ("fenêtre large, cron en retard").
```

- [ ] **Step 7: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [ ] **Step 8: Commit and push**

```bash
git add api/cron/tick.ts tests/cron-tick.test.ts .github/workflows/tick.yml README.md
git commit -m "feat: add notification tick cron route and 15-minute GitHub Actions schedule"
git push
```

---

## Self-Review Notes

- **Spec coverage:** §9's anti-spam rules (4/day cap, quiet hours, no-repeat-same-day, conditional) → `runNotificationTick` in Task 4. §9 table rows covered: "Plan du jour" (without the "nuit ?" tap — deferred, see Global Constraints), "Pesée hebdo", "Relance saisie", "Bilan hebdomadaire", "Diet break". Explicitly deferred: "Collation pré-séance" (no structured timing data), "Alerte performance" (no performance data source). §14 step 9 file (`/api/cron/tick.ts`) → Task 5.
- **Type consistency:** `NotificationContext.latestDailyState`'s shape (Task 3) matches `getMostRecentDailyState()`'s return type (Task 2) exactly, so `notificationTick.ts` (Task 4) passes it straight through with no remapping.
- **No Claude dependency, verified**: no file in this plan imports `lib/claude.js` — the entire feature is deterministic and testable/deployable independent of the still-blocked `ANTHROPIC_API_KEY`.
