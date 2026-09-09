# Weighed-meal food disambiguation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `log_weighed_meal`'s food lookup is ambiguous (e.g. "poulet" matches 69 Ciqual entries), stop silently guessing — surface the candidates so Claude can ask the user which one they meant, instead of picking an arbitrary match.

**Architecture:** `searchFood` (single-best-guess) becomes `searchFoodCandidates` (up to 5 matches, sorted shortest-name-first). `handleLogWeighedMealTool` resolves a food automatically only when there's exactly one candidate, or when one candidate is an exact normalized-name match; otherwise it collects the item as "ambiguous" and returns a clarification message instead of saving the meal — mirroring the existing "not found" behavior.

**Tech Stack:** Same as the rest of the project (Node/TS ESM, Prisma/MongoDB, Vitest).

**Spec:** `docs/spec-agent-nutrition-v4.md` §7 (mode 1 "pesée") — this plan refines step 6's implementation, no new spec section.

## Global Constraints

- No numeric calculation may be delegated to the LLM — unchanged from step 6; this plan only changes when a match is auto-accepted vs. needs clarification.
- Confirmed via direct query against the real imported `Food` collection: "poulet" alone matches **69** entries — disambiguation is not a theoretical edge case, it's the common case for generic food names.

---

### Task 1: `searchFoodCandidates` replaces `searchFood`

**Files:**
- Modify: `lib/foods.ts`
- Modify: `tests/foods.test.ts`

**Interfaces:**
- Produces: `searchFoodCandidates(query: string, limit?: number): Promise<FoodMatch[]>` (replaces `searchFood`, which returned a single `FoodMatch | null`). `FoodMatch` shape unchanged.

- [ ] **Step 1: Update the failing test**

Replace the contents of `tests/foods.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { searchFoodCandidates } from '../lib/foods.js';

describe('searchFoodCandidates', () => {
  it('finds real Ciqual foods by a partial, accent-insensitive query', async () => {
    const results = await searchFoodCandidates('riz basmati');

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((f) => f.name.toLowerCase().includes('riz basmati'))).toBe(true);
    expect(results[0].kcalPer100g).toBeGreaterThan(0);
  });

  it('returns an empty array when nothing matches', async () => {
    const results = await searchFoodCandidates('xyzzy-not-a-real-food-12345');
    expect(results).toEqual([]);
  });

  it('caps the number of candidates returned', async () => {
    const results = await searchFoodCandidates('poulet', 3);
    expect(results.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/foods.test.ts`
Expected: FAIL with "no export named 'searchFoodCandidates'"

- [ ] **Step 3: Implement in `lib/foods.ts`**

Replace the body of `lib/foods.ts` (keep the `FoodMatch` interface as-is):

```typescript
import { prisma } from './db.js';
import { normalizeFoodName } from './ciqualParser.js';

export interface FoodMatch {
  name: string;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

export async function searchFoodCandidates(query: string, limit = 5): Promise<FoodMatch[]> {
  const normalized = normalizeFoodName(query);

  const matches = await prisma.food.findMany({
    where: { nameNormalized: { contains: normalized } },
  });

  matches.sort((a, b) => a.name.length - b.name.length);
  return matches.slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/foods.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/foods.ts tests/foods.test.ts
git commit -m "refactor: searchFood -> searchFoodCandidates, return up to N matches"
```

---

### Task 2: Disambiguation in `handleLogWeighedMealTool`

**Files:**
- Modify: `lib/meals.ts`
- Modify: `tests/meals.test.ts`

**Interfaces:**
- Consumes: `searchFoodCandidates`, `normalizeFoodName` (from `lib/ciqualParser.js`, already imported project-wide).
- No exported signature changes — `handleLogWeighedMealTool`'s input/output shape is the same, only its internal resolution logic and the shape of its clarification message change.

- [ ] **Step 1: Update the failing tests**

In `tests/meals.test.ts`, change the `foodsLib` mock target from `searchFood` to `searchFoodCandidates` (returning arrays instead of single objects) in the existing "looks up each food..." test, and add a new ambiguous-match test. Replace the whole `describe('handleLogWeighedMealTool', ...)` block with:

```typescript
describe('handleLogWeighedMealTool', () => {
  const marker = `test-${Date.now()}-riz-poulet-pese`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.meal.delete({ where: { id: createdId } });
  });

  it('looks up each food, computes exact macros from grams, and saves with high confidence', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockImplementation(async (query: string) => {
      if (query.includes('riz')) {
        return [{ name: 'Riz basmati, cuit', kcalPer100g: 140, proteinPer100g: 3, carbsPer100g: 30, fatPer100g: 0.5 }];
      }
      if (query.includes('poulet')) {
        return [{ name: 'Poulet, blanc, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 }];
      }
      return [];
    });

    const result = await handleLogWeighedMealTool({
      rawDescription: marker,
      items: [
        { foodQuery: 'riz basmati cuit', grams: 200 },
        { foodQuery: 'poulet', grams: 150 },
      ],
    });

    expect(result).toContain('528');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: marker } });
    createdId = saved?.id;
    expect(saved?.inputType).toBe('text');
    expect(saved?.confidence).toBe('high');
    expect(saved?.kcalLow).toBe(saved?.kcalHigh);
    expect(saved?.items).toEqual([
      { name: 'Riz basmati, cuit', estimatedGrams: 200, kcal: 280, proteinG: 6, carbsG: 60, fatG: 1 },
      { name: 'Poulet, blanc, cuit', estimatedGrams: 150, kcal: 247.5, proteinG: 46.5, carbsG: 0, fatG: 5.4 },
    ]);
  });

  it('returns a clarification message and saves nothing when a food is not found', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([]);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-notfound`,
      items: [{ foodQuery: 'aliment-inexistant-xyz', grams: 100 }],
    });

    expect(result).toContain('non trouvé');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-notfound` } });
    expect(saved).toBeNull();
  });

  it('asks for clarification and saves nothing when a query matches multiple foods ambiguously', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: 'Poulet, cru', kcalPer100g: 120, proteinPer100g: 21, carbsPer100g: 0, fatPer100g: 3 },
      { name: 'Poulet, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 },
      { name: 'Poulet rôti', kcalPer100g: 190, proteinPer100g: 27, carbsPer100g: 0, fatPer100g: 9 },
    ]);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-ambiguous`,
      items: [{ foodQuery: 'poulet', grams: 150 }],
    });

    expect(result).toContain('Poulet, cru');
    expect(result).toContain('Poulet, cuit');
    expect(result).toContain('Poulet rôti');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-ambiguous` } });
    expect(saved).toBeNull();
  });

  it('auto-resolves when one candidate is an exact normalized-name match, even among several candidates', async () => {
    vi.spyOn(foodsLib, 'searchFoodCandidates').mockResolvedValue([
      { name: 'Poulet, cru', kcalPer100g: 120, proteinPer100g: 21, carbsPer100g: 0, fatPer100g: 3 },
      { name: 'Poulet, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 },
    ]);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-exact`,
      items: [{ foodQuery: 'Poulet, cuit', grams: 100 }],
    });

    expect(result).toContain('165');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-exact` } });
    expect(saved?.confidence).toBe('high');
    if (saved) await prisma.meal.delete({ where: { id: saved.id } });
  });
});
```

Also update the top-of-file import: `import { handleLogMealTool, handleLogWeighedMealTool } from '../lib/meals.js';` stays the same; no import line changes are needed beyond what step 6 already added.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/meals.test.ts`
Expected: FAIL — `foodsLib.searchFoodCandidates` doesn't exist yet (still calls old `searchFood`), and the ambiguous-match test has no matching behavior yet.

- [ ] **Step 3: Implement in `lib/meals.ts`**

Change the import:

```typescript
import { searchFoodCandidates } from './foods.js';
import { normalizeFoodName } from './ciqualParser.js';
```

Replace `handleLogWeighedMealTool`'s body:

```typescript
export async function handleLogWeighedMealTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogWeighedMealInput;

  const resolvedItems: MealItem[] = [];
  const notFound: string[] = [];
  const ambiguous: { query: string; candidateNames: string[] }[] = [];

  for (const item of input.items) {
    const candidates = await searchFoodCandidates(item.foodQuery);

    if (candidates.length === 0) {
      notFound.push(item.foodQuery);
      continue;
    }

    const exactMatch = candidates.find(
      (c) => normalizeFoodName(c.name) === normalizeFoodName(item.foodQuery)
    );
    const food = exactMatch ?? (candidates.length === 1 ? candidates[0] : undefined);

    if (!food) {
      ambiguous.push({ query: item.foodQuery, candidateNames: candidates.map((c) => c.name) });
      continue;
    }

    const ratio = item.grams / 100;
    resolvedItems.push({
      name: food.name,
      estimatedGrams: item.grams,
      kcal: food.kcalPer100g * ratio,
      proteinG: food.proteinPer100g * ratio,
      carbsG: food.carbsPer100g * ratio,
      fatG: food.fatPer100g * ratio,
    });
  }

  if (notFound.length > 0 || ambiguous.length > 0) {
    const parts: string[] = [];
    if (ambiguous.length > 0) {
      const list = ambiguous
        .map((a) => `"${a.query}" → ${a.candidateNames.map((n, i) => `${i + 1}) ${n}`).join(' ')}`)
        .join(' | ');
      parts.push(`Plusieurs aliments Ciqual correspondent, demande à l'utilisateur de préciser lequel : ${list}.`);
    }
    if (notFound.length > 0) {
      parts.push(
        `Aliment(s) non trouvé(s) dans la base Ciqual : ${notFound.join(', ')}. Décris-les autrement (plus simple ou plus générique) ou utilise le mode "repas décrit".`
      );
    }
    return parts.join(' ');
  }

  const totalKcal = resolvedItems.reduce((sum, i) => sum + i.kcal, 0);

  await prisma.meal.create({
    data: {
      inputType: 'text',
      rawDescription: input.rawDescription,
      items: resolvedItems as unknown as Prisma.InputJsonValue,
      kcalLow: totalKcal,
      kcalMid: totalKcal,
      kcalHigh: totalKcal,
      confidence: 'high',
      userCorrected: false,
    },
  });

  return `Repas pesé enregistré : ${totalKcal.toFixed(0)} kcal (${resolvedItems.length} aliment(s), confiance haute — lookup Ciqual).`;
}
```

Also update the `LOG_WEIGHED_MEAL_TOOL` description to mention the clarification flow, appending one sentence:

```typescript
  description:
    "Enregistre un repas pesé, quand l'utilisateur donne un grammage précis pour chaque aliment (ex: \"200g de riz basmati cuit, 150g de poulet\"). Ne calcule JAMAIS toi-même les calories ou macros : donne uniquement le nom de chaque aliment tel que décrit et son poids en grammes, l'outil fait la recherche dans la base Ciqual et le calcul exact. Si l'outil répond que plusieurs aliments correspondent, pose la question à l'utilisateur pour choisir, puis rappelle l'outil avec un nom plus précis.",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meals.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run full test suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS, no regressions

- [ ] **Step 6: Commit and push**

```bash
git add lib/meals.ts tests/meals.test.ts
git commit -m "feat: ask for clarification instead of guessing on ambiguous Ciqual food matches"
git push
```

---

## Self-Review Notes

- **Spec coverage:** this refines §7 mode 1 only; no new spec section is introduced.
- **Type consistency:** `FoodMatch[]` (Task 1) is consumed directly by `handleLogWeighedMealTool` (Task 2) with no shape changes to `FoodMatch` itself, only to the function that returns it (single → array).
- **Behavior change, intentional:** previously a multi-candidate query silently resolved to the shortest-named match. After this plan, that case now asks for clarification instead — this is the whole point of the change, not a regression to guard against.
