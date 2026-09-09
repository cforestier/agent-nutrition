# Step 6 — Saisie pesée + lookup Ciqual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user log a weighed meal ("200g de riz basmati cuit, 150g de poulet") with exact macros looked up from the official French Ciqual food-composition database, saved with `confidence = 'high'`, instead of an LLM estimate.

**Architecture:** A one-off import script parses the two Ciqual XML files (`data/alim_2025_11_03.xml` for names, `data/compo_2025_11_03.xml` for the 4 macro nutrient rows per food) into a new `Food` collection. A new `searchFood()` helper does a substring lookup by normalized name. A new `log_weighed_meal` tool lets Claude pass `{foodQuery, grams}` pairs — Claude never computes calories itself; the handler does the DB lookup and the `grams/100 * per100g` math in plain code, then saves a `Meal` exactly like the existing described-meal flow but with `confidence: 'high'`.

**Tech Stack:** Node.js/TypeScript ESM, Prisma/MongoDB Atlas, Vitest, `tsx` (new devDependency, to run the one-off import script directly).

**Spec:** `docs/spec-agent-nutrition-v4.md` — §7 "Repas — trois modes" (mode 1: Pesée), §15 item 6, `foods` collection in §14.

## Global Constraints

- Claude model stays `claude-opus-5` (`lib/claude.ts`) — no change needed in this plan, no new LLM prompt logic is added beyond tool descriptions.
- No numeric calculation may be delegated to the LLM — the tool's `input_schema` only accepts `foodQuery` (string) + `grams` (number); all kcal/macro math happens in `handleLogWeighedMealTool`.
- `data/*.xml` (in particular the 69MB `compo_2025_11_03.xml`) must never be committed to git.
- `Food` is Ciqual reference data, not mono-user singleton data — unlike `Profile`/`WeeklyDefault`, it's safe to read live in tests, and the import script is meant to write to the real Atlas DB (that's its entire purpose), following the same "hand-reviewed, no test file" precedent as `lib/profile.ts`.
- Ciqual `teneur` values use French comma-decimals and can be `-` (not determined), `traces`, or `&lt; X` (below detection limit) instead of a plain number — confirmed via direct inspection of `data/compo_2025_11_03.xml`. All three non-numeric cases must resolve to `0`, never crash the import or produce `NaN`.
- Confirmed via `grep` on the real data: all 3484 `<ALIM>` entries have exactly one `<COMPO>` row for each of the 4 target `const_code`s (328 kcal, 25000 protein, 31000 carbs, 40000 fat) — no food is missing a macro row entirely, though a minority (up to ~6%, e.g. water/spices) have a non-numeric `teneur` for one of them.

---

### Task 1: Prisma `Food` model + protect `data/` from git

**Files:**
- Modify: `prisma/schema.prisma` (append `Food` model)
- Modify: `.gitignore` (add `data/`)

**Interfaces:**
- Produces: `Food` Prisma model — `ciqualCode` (unique string), `name`, `nameNormalized`, `kcalPer100g`, `proteinPer100g`, `carbsPer100g`, `fatPer100g` (all `Float`, non-null per the constraint above), `createdAt`.

- [ ] **Step 1: Add `data/` to `.gitignore`**

Add a line `data/` to `C:\dev\agent-nutrition\.gitignore` (alongside the existing `node_modules`, `.env*`, `.vercel`, `dist` entries).

- [ ] **Step 2: Verify it's ignored**

Run: `git status`
Expected: `data/` no longer appears as an untracked file.

- [ ] **Step 3: Add the `Food` model to `prisma/schema.prisma`**

Append after the existing `Meal` model:

```prisma
model Food {
  id             String   @id @default(auto()) @map("_id") @db.ObjectId
  ciqualCode     String   @unique
  name           String
  nameNormalized String
  kcalPer100g    Float
  proteinPer100g Float
  carbsPer100g   Float
  fatPer100g     Float
  createdAt      DateTime @default(now())
}
```

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: succeeds, prints "Generated Prisma Client".

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors — `Food` isn't referenced anywhere yet, this just confirms the schema itself is valid TypeScript-generation-wise).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma .gitignore
git commit -m "feat: add Food prisma model for Ciqual import, gitignore data/"
```

---

### Task 2: Pure Ciqual XML parsing helpers

**Files:**
- Create: `lib/ciqualParser.ts`
- Test: `tests/ciqualParser.test.ts`

**Interfaces:**
- Produces:
  - `parseTeneurValue(raw: string): number`
  - `normalizeFoodName(name: string): string`
  - `parseAlimNames(xmlContent: string): { alimCode: string; nameFr: string }[]`
  - `parseCompoBlock(blockText: string): { alimCode: string; constCode: string; teneur: number } | null`
- Consumes: nothing (pure string-processing functions, no I/O, no Prisma).

- [ ] **Step 1: Write the failing tests**

Create `tests/ciqualParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseTeneurValue,
  normalizeFoodName,
  parseAlimNames,
  parseCompoBlock,
} from '../lib/ciqualParser.js';

describe('parseTeneurValue', () => {
  it('parses a plain comma-decimal number', () => {
    expect(parseTeneurValue(' 59,7 ')).toBeCloseTo(59.7, 5);
  });

  it('parses a plain integer', () => {
    expect(parseTeneurValue(' 274 ')).toBe(274);
  });

  it('treats an HTML-entity "less than" trace marker as its numeric value', () => {
    expect(parseTeneurValue(' &lt; 0,05 ')).toBeCloseTo(0.05, 5);
  });

  it('treats a literal "<" trace marker as its numeric value', () => {
    expect(parseTeneurValue(' < 1 ')).toBeCloseTo(1, 5);
  });

  it('treats "traces" as 0', () => {
    expect(parseTeneurValue(' traces ')).toBe(0);
  });

  it('treats "-" (not determined) as 0', () => {
    expect(parseTeneurValue(' - ')).toBe(0);
  });
});

describe('normalizeFoodName', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeFoodName('Riz basmati, cuit, sans sel ajouté')).toBe(
      'riz basmati, cuit, sans sel ajoute'
    );
  });
});

describe('parseAlimNames', () => {
  const fixture = `<TABLE>
<ALIM>
<alim_code> 1000 </alim_code>
<alim_nom_fr> Riz basmati, cuit, sans sel ajouté </alim_nom_fr>
<alim_nom_eng> Rice, basmati, cooked, unsalted </alim_nom_eng>
</ALIM>
<ALIM>
<alim_code> 1001 </alim_code>
<alim_nom_fr> Poulet, blanc, cuit </alim_nom_fr>
<alim_nom_eng> Chicken, breast, cooked </alim_nom_eng>
</ALIM>
</TABLE>`;

  it('extracts alim_code + alim_nom_fr for every ALIM block', () => {
    const result = parseAlimNames(fixture);
    expect(result).toEqual([
      { alimCode: '1000', nameFr: 'Riz basmati, cuit, sans sel ajouté' },
      { alimCode: '1001', nameFr: 'Poulet, blanc, cuit' },
    ]);
  });
});

describe('parseCompoBlock', () => {
  it('extracts alim_code, const_code and the parsed teneur from a COMPO block', () => {
    const block = `
      <alim_code> 1000 </alim_code>
      <const_code> 328 </const_code>
      <teneur> 274 </teneur>
      <min missing="1" />
      <max missing="1" />
      <code_confiance>A</code_confiance>
      <source_code>1</source_code>
    `;
    expect(parseCompoBlock(block)).toEqual({ alimCode: '1000', constCode: '328', teneur: 274 });
  });

  it('returns null when a required field is missing', () => {
    const block = `<const_code> 328 </const_code><teneur> 274 </teneur>`;
    expect(parseCompoBlock(block)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ciqualParser.test.ts`
Expected: FAIL with "Cannot find module '../lib/ciqualParser.js'"

- [ ] **Step 3: Implement `lib/ciqualParser.ts`**

```typescript
export function parseTeneurValue(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '-' || trimmed === '') return 0;
  if (trimmed.toLowerCase() === 'traces') return 0;
  const withoutLessThan = trimmed.replace(/^(&lt;|<)\s*/, '');
  const normalized = withoutLessThan.replace(',', '.');
  const value = parseFloat(normalized);
  return Number.isNaN(value) ? 0 : value;
}

export function normalizeFoodName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export interface CiqualFoodName {
  alimCode: string;
  nameFr: string;
}

export function parseAlimNames(xmlContent: string): CiqualFoodName[] {
  const blocks = xmlContent.split('<ALIM>').slice(1);
  const foods: CiqualFoodName[] = [];
  for (const block of blocks) {
    const codeMatch = block.match(/<alim_code>\s*([^<]*?)\s*<\/alim_code>/);
    const nameMatch = block.match(/<alim_nom_fr>\s*([^<]*?)\s*<\/alim_nom_fr>/);
    if (codeMatch && nameMatch) {
      foods.push({ alimCode: codeMatch[1].trim(), nameFr: nameMatch[1].trim() });
    }
  }
  return foods;
}

export interface CiqualCompoRow {
  alimCode: string;
  constCode: string;
  teneur: number;
}

export function parseCompoBlock(blockText: string): CiqualCompoRow | null {
  const alimMatch = blockText.match(/<alim_code>\s*([^<]*?)\s*<\/alim_code>/);
  const constMatch = blockText.match(/<const_code>\s*([^<]*?)\s*<\/const_code>/);
  const teneurMatch = blockText.match(/<teneur>\s*([^<]*?)\s*<\/teneur>/);
  if (!alimMatch || !constMatch || !teneurMatch) return null;
  return {
    alimCode: alimMatch[1].trim(),
    constCode: constMatch[1].trim(),
    teneur: parseTeneurValue(teneurMatch[1]),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ciqualParser.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/ciqualParser.ts tests/ciqualParser.test.ts
git commit -m "feat: add pure Ciqual XML parsing helpers"
```

---

### Task 3: Import script — run it against the real Ciqual data

**Files:**
- Create: `scripts/import-ciqual.ts`
- Modify: `package.json` (add `tsx` devDependency + `import:ciqual` script)
- Modify: `tsconfig.json` (add `"scripts"` to `include`)

**Interfaces:**
- Consumes: `parseAlimNames`, `parseCompoBlock`, `normalizeFoodName` from `lib/ciqualParser.js`; `prisma` from `lib/db.js`.
- Produces: populates the `Food` collection in the real Atlas DB. No exported symbols (this is a standalone script, run once from the CLI — consistent with the "DB-writing code reviewed by hand, no test file" precedent used for `lib/profile.ts`).

- [ ] **Step 1: Add `tsx` and the npm script**

Run: `npm install --save-dev tsx`

Then add to `package.json` `"scripts"`:

```json
"import:ciqual": "tsx scripts/import-ciqual.ts"
```

- [ ] **Step 2: Add `scripts` to `tsconfig.json`'s `include`**

```json
"include": ["api", "lib", "tests", "scripts"]
```

- [ ] **Step 3: Write `scripts/import-ciqual.ts`**

```typescript
import 'dotenv/config';
import { readFileSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { prisma } from '../lib/db.js';
import { parseAlimNames, parseCompoBlock, normalizeFoodName } from '../lib/ciqualParser.js';

const ALIM_PATH = fileURLToPath(new URL('../data/alim_2025_11_03.xml', import.meta.url));
const COMPO_PATH = fileURLToPath(new URL('../data/compo_2025_11_03.xml', import.meta.url));

const TARGET_CODES: Record<string, 'kcal' | 'protein' | 'carbs' | 'fat'> = {
  '328': 'kcal',
  '25000': 'protein',
  '31000': 'carbs',
  '40000': 'fat',
};

interface Macros {
  kcal?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

async function readMacrosByAlimCode(): Promise<Map<string, Macros>> {
  const macrosByCode = new Map<string, Macros>();
  const rl = createInterface({ input: createReadStream(COMPO_PATH, { encoding: 'utf-8' }) });

  let buffer: string[] = [];
  let inCompo = false;

  for await (const line of rl) {
    if (line.includes('<COMPO>')) {
      inCompo = true;
      buffer = [];
      continue;
    }
    if (line.includes('</COMPO>')) {
      inCompo = false;
      const row = parseCompoBlock(buffer.join('\n'));
      const key = row ? TARGET_CODES[row.constCode] : undefined;
      if (row && key) {
        const entry = macrosByCode.get(row.alimCode) ?? {};
        entry[key] = row.teneur;
        macrosByCode.set(row.alimCode, entry);
      }
      continue;
    }
    if (inCompo) buffer.push(line);
  }

  return macrosByCode;
}

async function main() {
  console.log('Reading food names...');
  const alimXml = readFileSync(ALIM_PATH, 'utf-8');
  const names = parseAlimNames(alimXml);
  console.log(`Found ${names.length} foods.`);

  console.log('Reading nutrient composition (this streams a 69MB file, may take a bit)...');
  const macrosByCode = await readMacrosByAlimCode();
  console.log(`Found macros for ${macrosByCode.size} foods.`);

  const BATCH_SIZE = 20;
  let imported = 0;

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ alimCode, nameFr }) => {
        const macros = macrosByCode.get(alimCode);
        if (!macros) return;
        await prisma.food.upsert({
          where: { ciqualCode: alimCode },
          create: {
            ciqualCode: alimCode,
            name: nameFr,
            nameNormalized: normalizeFoodName(nameFr),
            kcalPer100g: macros.kcal ?? 0,
            proteinPer100g: macros.protein ?? 0,
            carbsPer100g: macros.carbs ?? 0,
            fatPer100g: macros.fat ?? 0,
          },
          update: {
            name: nameFr,
            nameNormalized: normalizeFoodName(nameFr),
            kcalPer100g: macros.kcal ?? 0,
            proteinPer100g: macros.protein ?? 0,
            carbsPer100g: macros.carbs ?? 0,
            fatPer100g: macros.fat ?? 0,
          },
        });
        imported++;
      })
    );
  }

  console.log(`Imported/updated ${imported} foods.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run the import against the real Atlas DB**

Run: `npm run import:ciqual`
Expected: prints `Found 3484 foods.`, `Found macros for 3484 foods.`, `Imported/updated 3484 foods.` — takes roughly 1-3 minutes (streams the 69MB file, then does batched upserts over the network).

- [ ] **Step 6: Verify the import landed correctly**

Run: `node -e "import('./lib/db.js').then(async ({prisma}) => { console.log(await prisma.food.count()); const rice = await prisma.food.findFirst({where:{nameNormalized:{contains:'riz basmati'}}}); console.log(rice); await prisma.\$disconnect(); })"`

Expected: count is `3484`; the rice entry is found with `name` containing "Riz basmati" and a plausible `kcalPer100g` (roughly 100-200 for cooked rice).

- [ ] **Step 7: Commit**

```bash
git add scripts/import-ciqual.ts package.json package-lock.json tsconfig.json
git commit -m "feat: add Ciqual import script, run against real Atlas DB (3484 foods imported)"
```

---

### Task 4: `searchFood` lookup helper

**Files:**
- Create: `lib/foods.ts`
- Test: `tests/foods.test.ts`

**Interfaces:**
- Consumes: `prisma` from `lib/db.js`, `normalizeFoodName` from `lib/ciqualParser.js`.
- Produces: `searchFood(query: string): Promise<FoodMatch | null>`, `FoodMatch` interface (`name`, `kcalPer100g`, `proteinPer100g`, `carbsPer100g`, `fatPer100g`).
- This reads (never writes) the real `Food` collection populated by Task 3 — safe to live-test per the Global Constraints above.

- [ ] **Step 1: Write the failing test**

Create `tests/foods.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { searchFood } from '../lib/foods.js';

describe('searchFood', () => {
  it('finds a real Ciqual food by a partial, accent-insensitive query', async () => {
    const result = await searchFood('riz basmati');

    expect(result).not.toBeNull();
    expect(result?.name.toLowerCase()).toContain('riz basmati');
    expect(result?.kcalPer100g).toBeGreaterThan(0);
  });

  it('returns null when nothing matches', async () => {
    const result = await searchFood('xyzzy-not-a-real-food-12345');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/foods.test.ts`
Expected: FAIL with "Cannot find module '../lib/foods.js'"

- [ ] **Step 3: Implement `lib/foods.ts`**

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

export async function searchFood(query: string): Promise<FoodMatch | null> {
  const normalized = normalizeFoodName(query);

  const matches = await prisma.food.findMany({
    where: { nameNormalized: { contains: normalized } },
  });

  if (matches.length === 0) return null;

  matches.sort((a, b) => a.name.length - b.name.length);
  return matches[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/foods.test.ts`
Expected: PASS (requires the Task 3 import to have completed — the test queries the real imported data)

- [ ] **Step 5: Commit**

```bash
git add lib/foods.ts tests/foods.test.ts
git commit -m "feat: add searchFood Ciqual lookup helper"
```

---

### Task 5: `log_weighed_meal` tool

**Files:**
- Modify: `lib/meals.ts` (add alongside the existing `LOG_MEAL_TOOL` / `handleLogMealTool`)
- Modify: `tests/meals.test.ts`

**Interfaces:**
- Consumes: `searchFood` from `lib/foods.js`; existing `MealItem` interface (unchanged shape).
- Produces: `LOG_WEIGHED_MEAL_TOOL: ToolDefinition`, `handleLogWeighedMealTool(rawInput): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/meals.test.ts` (new imports at top: `import * as foodsLib from '../lib/foods.js';` and `import { handleLogWeighedMealTool } from '../lib/meals.js';`, plus `vi` from vitest which is already imported elsewhere in the suite — add `vi` to the existing `import { describe, it, expect, afterAll } from 'vitest';` line, making it `import { describe, it, expect, vi, afterAll } from 'vitest';`):

```typescript
describe('handleLogWeighedMealTool', () => {
  const marker = `test-${Date.now()}-riz-poulet-pese`;
  let createdId: string | undefined;

  afterAll(async () => {
    if (createdId) await prisma.meal.delete({ where: { id: createdId } });
  });

  it('looks up each food, computes exact macros from grams, and saves with high confidence', async () => {
    vi.spyOn(foodsLib, 'searchFood').mockImplementation(async (query: string) => {
      if (query.includes('riz')) {
        return { name: 'Riz basmati, cuit', kcalPer100g: 140, proteinPer100g: 3, carbsPer100g: 30, fatPer100g: 0.5 };
      }
      if (query.includes('poulet')) {
        return { name: 'Poulet, blanc, cuit', kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 };
      }
      return null;
    });

    const result = await handleLogWeighedMealTool({
      rawDescription: marker,
      items: [
        { foodQuery: 'riz basmati cuit', grams: 200 },
        { foodQuery: 'poulet', grams: 150 },
      ],
    });

    expect(result).toContain('530');

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
    vi.spyOn(foodsLib, 'searchFood').mockResolvedValue(null);

    const result = await handleLogWeighedMealTool({
      rawDescription: `${marker}-notfound`,
      items: [{ foodQuery: 'aliment-inexistant-xyz', grams: 100 }],
    });

    expect(result).toContain('non trouvé');

    const saved = await prisma.meal.findFirst({ where: { rawDescription: `${marker}-notfound` } });
    expect(saved).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/meals.test.ts`
Expected: FAIL with "no export named 'handleLogWeighedMealTool'"

- [ ] **Step 3: Implement in `lib/meals.ts`**

Add the import at the top (alongside the existing `Prisma`/`prisma`/`ToolDefinition` imports):

```typescript
import { searchFood } from './foods.js';
```

Tweak the existing `LOG_MEAL_TOOL` description so Claude routes correctly between the two tools — change its `description` string to:

```typescript
  description:
    "Enregistre un repas décrit en langage naturel, SANS grammage précis (ex: \"une assiette de pâtes bolognaise\"). Estime les aliments, leurs macronutriments, et donne TOUJOURS une fourchette calorique (kcalLow/kcalMid/kcalHigh) — jamais un chiffre unique, l'estimation par description reste approximative. Si l'utilisateur donne un grammage précis pour chaque aliment, utilise log_weighed_meal à la place.",
```

Then append at the end of the file:

```typescript
export interface WeighedMealItemInput {
  foodQuery: string;
  grams: number;
}

export interface LogWeighedMealInput {
  rawDescription: string;
  items: WeighedMealItemInput[];
}

export const LOG_WEIGHED_MEAL_TOOL: ToolDefinition = {
  name: 'log_weighed_meal',
  description:
    "Enregistre un repas pesé, quand l'utilisateur donne un grammage précis pour chaque aliment (ex: \"200g de riz basmati cuit, 150g de poulet\"). Ne calcule JAMAIS toi-même les calories ou macros : donne uniquement le nom de chaque aliment tel que décrit et son poids en grammes, l'outil fait la recherche dans la base Ciqual et le calcul exact.",
  input_schema: {
    type: 'object',
    properties: {
      rawDescription: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            foodQuery: { type: 'string', description: "Nom de l'aliment tel que décrit par l'utilisateur" },
            grams: { type: 'number' },
          },
          required: ['foodQuery', 'grams'],
        },
      },
    },
    required: ['rawDescription', 'items'],
  },
};

export async function handleLogWeighedMealTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogWeighedMealInput;

  const resolvedItems: MealItem[] = [];
  const notFound: string[] = [];

  for (const item of input.items) {
    const food = await searchFood(item.foodQuery);
    if (!food) {
      notFound.push(item.foodQuery);
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

  if (notFound.length > 0) {
    return `Aliment(s) non trouvé(s) dans la base Ciqual : ${notFound.join(', ')}. Décris-les autrement (plus simple ou plus générique) ou utilise le mode "repas décrit".`;
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meals.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests PASS (no regressions from the `LOG_MEAL_TOOL` description change)

- [ ] **Step 6: Commit**

```bash
git add lib/meals.ts tests/meals.test.ts
git commit -m "feat: add log_weighed_meal tool with exact Ciqual-based macro calculation"
```

---

### Task 6: Wire `log_weighed_meal` into the webhook

**Files:**
- Modify: `api/telegram/webhook.ts`
- Modify: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `LOG_WEIGHED_MEAL_TOOL`, `handleLogWeighedMealTool` from `lib/meals.js`.

- [ ] **Step 1: Update the failing test**

In `tests/webhook.test.ts`, update the import and the expected tools array in the first `it("responds 200 and replies...")` test:

```typescript
import { LOG_MEAL_TOOL, LOG_WEIGHED_MEAL_TOOL } from '../lib/meals.js';
```

And change the `converseWithToolSpy` assertion's tools array to:

```typescript
      [
        ...scenariosLib.SCENARIO_TOOLS,
        SET_WEEKLY_SCHEDULE_TOOL,
        LOG_WEIGHT_TOOL,
        LOG_MEAL_TOOL,
        LOG_WEIGHED_MEAL_TOOL,
        FLAG_CONCERN_TOOL,
      ],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — actual tools array doesn't include `LOG_WEIGHED_MEAL_TOOL` yet.

- [ ] **Step 3: Wire it into `api/telegram/webhook.ts`**

Change the import line:

```typescript
import { LOG_MEAL_TOOL, LOG_WEIGHED_MEAL_TOOL, handleLogMealTool, handleLogWeighedMealTool } from '../../lib/meals.js';
```

Update `GENERAL_CHAT_TOOLS`:

```typescript
const GENERAL_CHAT_TOOLS = [
  ...SCENARIO_TOOLS,
  SET_WEEKLY_SCHEDULE_TOOL,
  LOG_WEIGHT_TOOL,
  LOG_MEAL_TOOL,
  LOG_WEIGHED_MEAL_TOOL,
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
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (all webhook tests)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: wire log_weighed_meal tool into the general chat webhook"
```

- [ ] **Step 8: Push**

```bash
git push
```

---

## Self-Review Notes

- **Spec coverage:** §7 mode 1 (pesée → Ciqual lookup → `confidence='high'`) is implemented end-to-end (Tasks 2-5); the `foods` collection from §14 is Task 1/3; the "no numeric calculation in the LLM" principle (implicit throughout the spec, explicit in the onboarding tool) is enforced by the `log_weighed_meal` tool schema only accepting `foodQuery`+`grams`, never kcal/macro numbers, mirrored in the Global Constraints section.
- **Type consistency:** `FoodMatch` (Task 4) fields (`kcalPer100g`, `proteinPer100g`, `carbsPer100g`, `fatPer100g`) match the `Food` Prisma model (Task 1) field names exactly, and `handleLogWeighedMealTool` (Task 5) maps them onto the existing `MealItem` shape (`kcal`, `proteinG`, `carbsG`, `fatG`) already used by `handleLogMealTool`.
- **Out of scope for this plan** (unchanged from the spec's own ordering): mode 2 (described meal) and mode 3 (photo) already exist / are separately scoped; the daily recompute loop (step 8) is not touched.
