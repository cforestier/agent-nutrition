# Routines d'activité récurrentes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre de définir des routines d'activité nommées et réutilisables (ex: "aller au bureau"), estimées via MET ou un kcal connu, appliquées proactivement (avant que l'activité ait eu lieu) et affinées par une moyenne apprise des vrais logs — avec application automatique + confirmation par boutons pour les routines à jour(s) de semaine récurrent(s), et une extension générique de `log_activity` pour annoncer une activité ponctuelle à l'avance.

**Architecture:** Nouveau modèle Prisma `ActivityRoutine` + extension d'`ActivityLog` (routineId/status/plannedTime). Deux nouveaux outils conversationnels (`define_activity_routine`, `apply_activity_routine`) dans un nouveau fichier `lib/activityRoutine.ts`, réutilisant les fonctions MET/rabais extraites de `lib/activity.ts`. `DayPlan.eventBonusKcal` passe d'une valeur écrasée à une somme recalculée (`recomputeEventBonusForDate`) — corrige un bug réel trouvé en conception. Une étape quotidienne dans `runNotificationTick` auto-applique les routines dues et envoie un message à boutons ; `handleCallbackQuery` (webhook) traite la confirmation/annulation.

**Tech Stack:** TypeScript, Prisma + MongoDB, Vercel serverless functions, Vitest contre une vraie base MongoDB de test.

**Spec:** `docs/superpowers/specs/2026-09-13-activity-routines-design.md`

## Global Constraints

- Le calcul du TDEE observé (`lib/calc/tdee.ts`, `lib/dailyRecompute.ts`) n'est **pas modifié** par ce plan — les routines n'ajoutent que des bonus ponctuels via `DayPlan.eventBonusKcal`, jamais de changement à `computeAdjustment`/`profile.currentTargetKcal`.
- MongoDB via Prisma : pas de migrations, seulement éditer `prisma/schema.prisma` puis `npx prisma generate`.
- Les tests tournent contre une vraie base MongoDB de test (pas de mocks Prisma) — utiliser des dates fixes anciennes et **jamais réutilisées ailleurs dans le repo** pour éviter les collisions entre fichiers de test (voir chaque tâche pour les dates assignées).
- Tous les textes utilisateur restent en français, ton factuel cohérent avec l'existant (`lib/activity.ts`, `lib/scenarios.ts`).
- `SPORT_DISCOUNTS`/le calcul MET restent la seule source de vérité pour les rabais et l'estimation calorique — aucune duplication de ces valeurs ailleurs.
- Après chaque tâche : `npx tsc --noEmit` doit passer sans erreur avant de commiter.

---

### Task 1: Ajouter la marche (walking) à la table MET et extraire les helpers réutilisables

**Files:**
- Modify: `lib/activity.ts`
- Test: `tests/activity.test.ts`

**Interfaces:**
- Produces: `export function lookupMet(sportType: SportType, intensity: Intensity): number | undefined`, `export function metToKcal(met: number, durationMinutes: number, weightKg: number): number`, `export const SPORT_DISCOUNTS: Record<SportType, number>` (passe d'un `const` privé à `export const`), `SportType` inclut désormais `'walking'`.

- [ ] **Step 1: Écrire les tests qui échouent (nouvelle table MET + helpers exportés)**

Ajouter en haut de `tests/activity.test.ts`, dans les imports :

```ts
import { handleLogActivityTool, lookupMet, metToKcal } from '../lib/activity.js';
```

Ajouter à la fin du fichier (après le dernier `it(...)` du `describe('handleLogActivityTool', ...)`, avant la fermeture du `describe`) :

```ts
  it('estimates walking calories via the MET table', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[7],
      description: "marche jusqu'à la gare",
      sportType: 'walking',
      durationMinutes: 15,
      intensity: 'moderate',
      relationToPlan: 'additional',
    });

    // met = 3.5 ; kcal = 3.5 * 3.5 * 80 / 200 * 15 = 73.5 -> 74 ; rabais other 35% -> 74*0.65=48.1 < seuil 100
    expect(result).toContain('74');
    expect(result).toContain('trop faible');
  });
});

describe('metToKcal / lookupMet', () => {
  it('computes kcal from a MET value, duration, and weight', () => {
    expect(metToKcal(6.8, 20, 80)).toBeCloseTo(381, 0);
  });

  it('returns undefined for an unknown sport/intensity pair', () => {
    expect(lookupMet('strength', 'moderate')).toBeUndefined();
  });

  it('looks up the new walking MET table', () => {
    expect(lookupMet('walking', 'light')).toBe(2.8);
  });
});
```

Modifier la ligne `const dates = [...]` en haut du `describe('handleLogActivityTool', ...)` pour ajouter une 8ème date :

```ts
  const dates = ['1999-07-05', '1999-07-06', '1999-07-07', '1999-07-08', '1999-07-09', '1999-07-10', '1999-07-11', '1999-07-12'];
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/activity.test.ts`
Expected: FAIL — `lookupMet`/`metToKcal` non exportés, `walking` non reconnu par le schéma de l'outil (le test `it('estimates walking...')` échoue avec un message d'erreur de l'outil plutôt que le résultat attendu).

- [ ] **Step 3: Implémenter dans `lib/activity.ts`**

Remplacer le haut du fichier (types, `SPORT_DISCOUNTS`, `MET_TABLE`) :

```ts
export type SportType = 'cycling' | 'running' | 'strength' | 'crossfit' | 'walking' | 'other';
export type Intensity = 'light' | 'moderate' | 'sustained' | 'vigorous' | 'maximal';

export const SPORT_DISCOUNTS: Record<SportType, number> = {
  cycling: 0.2,
  running: 0.25,
  strength: 0.3,
  crossfit: 0.3,
  walking: 0.35,
  other: 0.35,
};

// MET (Metabolic Equivalent of Task) values per activité x intensité, utilisés pour estimer
// la dépense calorique à partir de la durée quand aucune mesure d'appareil n'est disponible.
const MET_TABLE: Partial<Record<SportType, Record<Intensity, number>>> = {
  cycling: { light: 4.0, moderate: 6.8, sustained: 8.0, vigorous: 10.0, maximal: 12.0 },
  running: { light: 6.0, moderate: 9.8, sustained: 11.0, vigorous: 12.8, maximal: 16.0 },
  crossfit: { light: 3.5, moderate: 7.0, sustained: 8.0, vigorous: 10.0, maximal: 12.0 },
  walking: { light: 2.8, moderate: 3.5, sustained: 4.3, vigorous: 5.0, maximal: 6.0 },
};

export function lookupMet(sportType: SportType, intensity: Intensity): number | undefined {
  return MET_TABLE[sportType]?.[intensity];
}

export function metToKcal(met: number, durationMinutes: number, weightKg: number): number {
  return Math.round(((met * 3.5 * weightKg) / 200) * durationMinutes);
}
```

Mettre à jour l'enum `sportType` dans `LOG_ACTIVITY_TOOL.input_schema.properties.sportType` :

```ts
      sportType: { type: 'string', enum: ['cycling', 'running', 'strength', 'crossfit', 'walking', 'other'] },
```

Dans `handleLogActivityTool`, remplacer le bloc d'estimation MET (qui utilisait `MET_TABLE[...]` directement) par les helpers exportés :

```ts
  } else {
    if (profile.weightKg === null) {
      return "Le poids actuel de l'utilisateur n'est pas encore connu, nécessaire pour estimer la dépense calorique à partir de la durée et de l'intensité. Demande-lui son poids avant de continuer.";
    }
    const met = lookupMet(input.sportType, input.intensity as Intensity);
    if (met === undefined) {
      return `Aucune table d'estimation calorique n'existe pour le type d'activité "${input.sportType}" — demande à l'utilisateur les calories affichées par sa montre/tracker pour cette activité.`;
    }
    reportedCalories = metToKcal(met, input.durationMinutes as number, profile.weightKg);
    estimationMethod = 'met_estimate';
    metUsed = met;
  }
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/activity.test.ts`
Expected: PASS (tous les tests, y compris les 3 nouveaux)

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add lib/activity.ts tests/activity.test.ts
git commit -m "feat: add walking to the MET table, export lookupMet/metToKcal"
```

---

### Task 2: Corriger le cumul des bonus du jour (`recomputeEventBonusForDate`)

**Files:**
- Modify: `lib/activity.ts`
- Test: `tests/activity.test.ts`

**Interfaces:**
- Consumes: rien de nouveau (utilise `prisma` déjà importé).
- Produces: `export async function recomputeEventBonusForDate(date: string): Promise<void>` — utilisé par les tâches 5, 7 et 10.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/activity.test.ts`, dans les imports :

```ts
import { handleLogActivityTool, lookupMet, metToKcal, recomputeEventBonusForDate } from '../lib/activity.js';
```

Remplacer le test existant `'does not adjust the target when the discounted gap is below the materiality threshold'` — la dernière assertion change car `DayPlan` est maintenant toujours créé (avec un bonus à 0) au lieu de rester absent :

```ts
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

    expect(result).toContain('trop faible');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[2] } });
    expect(log?.bonusKcal).toBe(0);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[2] } });
    expect(dayPlan?.eventBonusKcal).toBe(0);
    expect(dayPlan?.isAtypical).toBe(false);
  });
```

Ajouter un nouveau test dans le même `describe('handleLogActivityTool', ...)`, après le test `'estimates walking calories via the MET table'` :

```ts
  it('sums bonuses across multiple activities logged the same day instead of overwriting', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    await handleLogActivityTool({
      date: dates[8],
      description: 'vélo du matin',
      sportType: 'cycling',
      reportedCalories: 400,
      relationToPlan: 'additional',
    });
    await handleLogActivityTool({
      date: dates[8],
      description: 'course du midi',
      sportType: 'running',
      reportedCalories: 300,
      relationToPlan: 'additional',
    });

    // bonus1 = 400*(1-0.2)=320 ; bonus2 = 300*(1-0.25)=225
    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: dates[8] } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(320 + 225, 5);
  });
```

Mettre à jour le tableau `dates` pour ajouter une 9ème entrée :

```ts
  const dates = ['1999-07-05', '1999-07-06', '1999-07-07', '1999-07-08', '1999-07-09', '1999-07-10', '1999-07-11', '1999-07-12', '1999-07-13'];
```

Ajouter un nouveau `describe` en fin de fichier, après `describe('metToKcal / lookupMet', ...)` :

```ts
describe('recomputeEventBonusForDate', () => {
  const date = '1998-05-01';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date } });
    await prisma.dayPlan.deleteMany({ where: { date } });
  });

  it('sums bonusKcal across all ActivityLog rows for the date', async () => {
    await prisma.activityLog.createMany({
      data: [
        { date, description: 'a', sportType: 'cycling', reportedCalories: 100, relationToPlan: 'additional', baselineKcal: 0, rawDiffKcal: 100, discountPct: 0, bonusKcal: 150 },
        { date, description: 'b', sportType: 'running', reportedCalories: 100, relationToPlan: 'additional', baselineKcal: 0, rawDiffKcal: 100, discountPct: 0, bonusKcal: 50 },
      ],
    });

    await recomputeEventBonusForDate(date);

    const dayPlan = await prisma.dayPlan.findUnique({ where: { date } });
    expect(dayPlan?.eventBonusKcal).toBe(200);
    expect(dayPlan?.isAtypical).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/activity.test.ts`
Expected: FAIL — `recomputeEventBonusForDate` n'existe pas encore ; le test du seuil de matérialité échoue car `dayPlan` est actuellement `null` (pas encore créé) ; le test de cumul échoue car le 2e appel écrase le bonus du 1er.

- [ ] **Step 3: Implémenter dans `lib/activity.ts`**

Ajouter la fonction exportée (à la suite de `metToKcal`) :

```ts
export async function recomputeEventBonusForDate(date: string): Promise<void> {
  const logs = await prisma.activityLog.findMany({ where: { date } });
  const total = logs.reduce((sum, log) => sum + log.bonusKcal, 0);
  await prisma.dayPlan.upsert({
    where: { date },
    create: { date, scenariosApplied: [], segmentsResolved: [], isAtypical: total !== 0, eventBonusKcal: total },
    update: { isAtypical: total !== 0, eventBonusKcal: total },
  });
}
```

Dans `handleLogActivityTool`, remplacer le bloc final (depuis la création d'`ActivityLog` jusqu'au `return` final) par :

```ts
  await prisma.activityLog.create({
    data: {
      date: input.date,
      description: input.description,
      sportType: input.sportType,
      reportedCalories,
      relationToPlan: input.relationToPlan,
      baselineKcal,
      rawDiffKcal,
      discountPct,
      bonusKcal,
      intensity: input.intensity,
      durationMinutes: input.durationMinutes,
      estimationMethod,
      metUsed: metUsed ?? undefined,
    },
  });

  await recomputeEventBonusForDate(input.date);

  const calorieNote = estimationMethod === 'met_estimate' ? `${reportedCalories} kcal estimées` : `${reportedCalories} kcal`;

  if (bonusKcal === 0) {
    return `Activité enregistrée (${input.description}, ${calorieNote}). Écart avec le prévu trop faible (moins de ${MATERIALITY_THRESHOLD_KCAL} kcal après rabais) pour ajuster ta cible — considérée comme normale.`;
  }

  const sign = bonusKcal > 0 ? '+' : '';
  const newTargetNote =
    profile.currentTargetKcal !== null ? ` → ${(profile.currentTargetKcal + bonusKcal).toFixed(0)} kcal aujourd'hui` : '';

  return `Activité enregistrée (${input.description}, ${calorieNote}, rabais ${(discountPct * 100).toFixed(0)}%). Cible du jour ajustée de ${sign}${bonusKcal.toFixed(0)} kcal${newTargetNote}.`;
```

(supprime l'ancien `await prisma.dayPlan.upsert({...})` conditionnel qui écrasait `eventBonusKcal`.)

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/activity.test.ts`
Expected: PASS (tous les tests)

- [ ] **Step 5: Vérifier qu'aucun autre test n'est cassé, typecheck, commit**

Run: `npx vitest run tests/dailyRecompute.test.ts` (dépend de `DayPlan.eventBonusKcal` — vérifier qu'il passe toujours)
Run: `npx tsc --noEmit`

```bash
git add lib/activity.ts tests/activity.test.ts
git commit -m "fix: sum same-day activity bonuses instead of overwriting DayPlan.eventBonusKcal"
```

---

### Task 3: Schéma Prisma — `ActivityRoutine` + extension d'`ActivityLog`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: modèle `ActivityRoutine`, champs `routineId`/`status`/`plannedTime` sur `ActivityLog`.

- [ ] **Step 1: Modifier `prisma/schema.prisma`**

Remplacer le modèle `ActivityLog` existant par :

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
  intensity        String?
  durationMinutes  Float?
  estimationMethod String?
  metUsed          Float?
  routineId        String?
  status           String   @default("done")
  plannedTime      String?
  createdAt        DateTime @default(now())
}
```

Ajouter un nouveau modèle, juste après `ActivityLog` :

```prisma
model ActivityRoutine {
  id                 String   @id @default(auto()) @map("_id") @db.ObjectId
  name               String   @unique
  aliases            String[]
  legs               Json?
  primarySportType   String?
  estimatedKcal      Float
  blendedDiscountPct Float
  observedAvgKcal    Float?
  sampleCount        Int      @default(0)
  recurringWeekdays  String[]
  timeRangeStart     String?
  timeRangeEnd       String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

- [ ] **Step 2: Régénérer le client Prisma**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 3: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add prisma/schema.prisma
git commit -m "feat: add ActivityRoutine model and extend ActivityLog for routines"
```

---

### Task 4: Outil `define_activity_routine`

**Files:**
- Create: `lib/activityRoutine.ts`
- Test: `tests/activityRoutine.test.ts`

**Interfaces:**
- Consumes: `lookupMet`, `metToKcal`, `SPORT_DISCOUNTS`, `SportType`, `Intensity` (Task 1, `lib/activity.js`) ; `getProfileSnapshot` (`lib/profile.js`) ; `WEEKDAYS` (`lib/weeklySchedule.js`).
- Produces: `DEFINE_ACTIVITY_ROUTINE_TOOL: ToolDefinition`, `export async function handleDefineActivityRoutineTool(rawInput: Record<string, unknown>): Promise<string>`, `RoutineLeg` interface — utilisés par la tâche 6 (câblage webhook) et la tâche 8 (onboarding).

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `tests/activityRoutine.test.ts` :

```ts
import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleDefineActivityRoutineTool } from '../lib/activityRoutine.js';
import * as profileLib from '../lib/profile.js';

function baseProfile(weightKg: number | null) {
  return {
    weightKg,
    ratePctPerWeek: 0.5,
    currentTargetKcal: 2500,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('handleDefineActivityRoutineTool', () => {
  afterAll(async () => {
    await prisma.activityRoutine.deleteMany({
      where: { name: { in: ['aller au bureau', 'routine kcal connu', 'incomplet', 'routine sans poids'] } },
    });
  });

  it('computes estimatedKcal and a blended discount from mixed-sport legs via the MET table', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(80));

    const result = await handleDefineActivityRoutineTool({
      name: 'aller au bureau',
      aliases: ['bureau', 'boulot'],
      legs: [
        { sportType: 'cycling', durationMinutes: 10, intensity: 'moderate' },
        { sportType: 'running', durationMinutes: 10, intensity: 'moderate' },
      ],
    });

    // cycling: 6.8*3.5*80/200*10 = 95.2 -> 95 ; running: 9.8*3.5*80/200*10 = 137.2 -> 137 ; total = 232
    // rabais pondéré = (95*0.2 + 137*0.25) / 232 ≈ 0.2295 -> "23%"
    expect(result).toContain('232');
    expect(result).toContain('23%');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'aller au bureau' } });
    expect(routine?.estimatedKcal).toBeCloseTo(232, 0);
    expect(routine?.blendedDiscountPct).toBeCloseTo(0.2295, 3);
    expect(routine?.sampleCount).toBe(0);
    expect(routine?.observedAvgKcal).toBeNull();
  });

  it('accepts a directly known kcal total with a primary sport type', async () => {
    const result = await handleDefineActivityRoutineTool({
      name: 'routine kcal connu',
      aliases: [],
      estimatedKcal: 500,
      primarySportType: 'running',
    });

    expect(result).toContain('500');
    expect(result).toContain('25%');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine kcal connu' } });
    expect(routine?.estimatedKcal).toBe(500);
    expect(routine?.blendedDiscountPct).toBeCloseTo(0.25, 5);
  });

  it('rejects a definition with neither legs nor a known kcal total', async () => {
    const result = await handleDefineActivityRoutineTool({ name: 'incomplet', aliases: [] });
    expect(result).toContain('manque');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'incomplet' } });
    expect(routine).toBeNull();
  });

  it('asks for the missing weight when legs are given without a known weight', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(null));

    const result = await handleDefineActivityRoutineTool({
      name: 'routine sans poids',
      aliases: [],
      legs: [{ sportType: 'cycling', durationMinutes: 10, intensity: 'moderate' }],
    });

    expect(result).toContain('poids');
    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine sans poids' } });
    expect(routine).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/activityRoutine.test.ts`
Expected: FAIL — `lib/activityRoutine.js` n'existe pas.

- [ ] **Step 3: Créer `lib/activityRoutine.ts`**

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { getProfileSnapshot } from './profile.js';
import { lookupMet, metToKcal, SPORT_DISCOUNTS } from './activity.js';
import type { SportType, Intensity } from './activity.js';
import { WEEKDAYS } from './weeklySchedule.js';
import type { ToolDefinition } from './claude.js';

export interface RoutineLeg {
  sportType: SportType;
  durationMinutes: number;
  intensity: Intensity;
}

const SPORT_TYPE_ENUM = ['cycling', 'running', 'strength', 'crossfit', 'walking', 'other'] as const;
const INTENSITY_ENUM = ['light', 'moderate', 'sustained', 'vigorous', 'maximal'] as const;

export const DEFINE_ACTIVITY_ROUTINE_TOOL: ToolDefinition = {
  name: 'define_activity_routine',
  description:
    "Crée une routine d'activité nommée et réutilisable (ex: \"aller au bureau\"), pas liée à un seul jour de semaine. " +
    "Utilise `legs` si l'utilisateur ne connaît pas le total et décrit chaque étape (sport, durée, intensité) — l'estimation se calcule via une table MET. " +
    "Utilise `estimatedKcal` + `primarySportType` si l'utilisateur connaît déjà le total (montre, historique). " +
    "`recurringWeekdays` : jours de la semaine où cette routine a lieu habituellement, pour qu'elle s'applique automatiquement chaque semaine sans que l'utilisateur ait à le redemander — laisse vide si c'est une routine ponctuelle réutilisable sans jour fixe. " +
    "Demande la tranche horaire (timeRangeStart/End) si l'utilisateur ne l'a pas donnée spontanément. " +
    "N'appelle cet outil qu'après avoir confirmé les détails avec l'utilisateur.",
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      legs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sportType: { type: 'string', enum: [...SPORT_TYPE_ENUM] },
            durationMinutes: { type: 'number' },
            intensity: { type: 'string', enum: [...INTENSITY_ENUM] },
          },
          required: ['sportType', 'durationMinutes', 'intensity'],
        },
      },
      estimatedKcal: { type: 'number' },
      primarySportType: { type: 'string', enum: [...SPORT_TYPE_ENUM] },
      recurringWeekdays: { type: 'array', items: { type: 'string', enum: [...WEEKDAYS] } },
      timeRangeStart: { type: 'string', description: 'HH:MM' },
      timeRangeEnd: { type: 'string', description: 'HH:MM' },
    },
    required: ['name', 'aliases'],
  },
};

export interface DefineActivityRoutineInput {
  name: string;
  aliases: string[];
  legs?: RoutineLeg[];
  estimatedKcal?: number;
  primarySportType?: SportType;
  recurringWeekdays?: string[];
  timeRangeStart?: string;
  timeRangeEnd?: string;
}

export async function handleDefineActivityRoutineTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as DefineActivityRoutineInput;

  if (!input.legs && (input.estimatedKcal === undefined || !input.primarySportType)) {
    return "Il manque soit le détail des étapes (legs), soit un total kcal connu + le sport principal — demande l'info manquante à l'utilisateur.";
  }

  let estimatedKcal: number;
  let blendedDiscountPct: number;

  if (input.legs && input.legs.length > 0) {
    const profile = await getProfileSnapshot();
    if (profile.weightKg === null) {
      return "Le poids actuel de l'utilisateur n'est pas encore connu, nécessaire pour estimer la dépense calorique des étapes. Demande-lui son poids avant de continuer.";
    }

    let totalKcal = 0;
    let weightedDiscount = 0;
    for (const leg of input.legs) {
      const met = lookupMet(leg.sportType, leg.intensity);
      if (met === undefined) {
        return `Aucune table d'estimation calorique n'existe pour le type d'activité "${leg.sportType}" — demande à l'utilisateur les calories connues pour cette routine plutôt que le détail des étapes.`;
      }
      const legKcal = metToKcal(met, leg.durationMinutes, profile.weightKg);
      totalKcal += legKcal;
      weightedDiscount += legKcal * SPORT_DISCOUNTS[leg.sportType];
    }
    estimatedKcal = totalKcal;
    blendedDiscountPct = totalKcal > 0 ? weightedDiscount / totalKcal : 0;
  } else {
    estimatedKcal = input.estimatedKcal as number;
    blendedDiscountPct = SPORT_DISCOUNTS[input.primarySportType as SportType];
  }

  await prisma.activityRoutine.create({
    data: {
      name: input.name,
      aliases: input.aliases,
      legs: input.legs as unknown as Prisma.InputJsonValue | undefined,
      primarySportType: input.primarySportType,
      estimatedKcal,
      blendedDiscountPct,
      sampleCount: 0,
      recurringWeekdays: input.recurringWeekdays ?? [],
      timeRangeStart: input.timeRangeStart,
      timeRangeEnd: input.timeRangeEnd,
    },
  });

  return `Routine "${input.name}" créée : estimation initiale ${estimatedKcal.toFixed(0)} kcal (rabais ${(blendedDiscountPct * 100).toFixed(0)}%).`;
}

export async function findRoutineByNameOrAlias(nameOrAlias: string) {
  const needle = nameOrAlias.trim().toLowerCase();
  const routines = await prisma.activityRoutine.findMany();
  return routines.find(
    (r) => r.name.toLowerCase() === needle || r.aliases.some((a) => a.toLowerCase() === needle)
  );
}
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/activityRoutine.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add lib/activityRoutine.ts tests/activityRoutine.test.ts
git commit -m "feat: add define_activity_routine tool (MET-based or known-kcal estimation)"
```

---

### Task 5: Outil `apply_activity_routine`

**Files:**
- Modify: `lib/activityRoutine.ts`
- Test: `tests/activityRoutine.test.ts`

**Interfaces:**
- Consumes: `findRoutineByNameOrAlias` (Task 4, même fichier), `recomputeEventBonusForDate` (Task 2, `lib/activity.js`).
- Produces: `APPLY_ACTIVITY_ROUTINE_TOOL: ToolDefinition`, `export async function handleApplyActivityRoutineTool(rawInput: Record<string, unknown>): Promise<string>` — utilisés par la tâche 6.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/activityRoutine.test.ts`, dans les imports :

```ts
import { handleDefineActivityRoutineTool, handleApplyActivityRoutineTool } from '../lib/activityRoutine.js';
```

Ajouter un nouveau `describe`, à la fin du fichier :

```ts
describe('handleApplyActivityRoutineTool', () => {
  const date1 = '1998-05-10';
  const date2 = '1998-05-11';

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { date: { in: [date1, date2] } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: [date1, date2] } } });
    await prisma.activityRoutine.deleteMany({ where: { name: 'routine test apply' } });
  });

  it('applies the initial estimate proactively when no reportedKcal is given', async () => {
    await prisma.activityRoutine.create({
      data: {
        name: 'routine test apply',
        aliases: ['rta'],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: [],
      },
    });

    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date1 });

    // bonus = 300 * (1-0.2) = 240
    expect(result).toContain('240');
    expect(result).toContain('anticipation');

    const log = await prisma.activityLog.findFirst({ where: { date: date1, description: 'routine test apply' } });
    expect(log?.status).toBe('planned');
    expect(log?.bonusKcal).toBeCloseTo(240, 5);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: date1 } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(240, 5);

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine test apply' } });
    expect(routine?.sampleCount).toBe(0);
    expect(routine?.observedAvgKcal).toBeNull();
  });

  it('replaces the estimated total with a real reported total and updates the running average', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date1, reportedKcal: 400 });

    // bonus = 400 * (1-0.2) = 320
    expect(result).toContain('320');
    expect(result).toContain('réelle');

    const logs = await prisma.activityLog.findMany({ where: { date: date1, description: 'routine test apply' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('done');
    expect(logs[0].bonusKcal).toBeCloseTo(320, 5);

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: date1 } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(320, 5);

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine test apply' } });
    expect(routine?.sampleCount).toBe(1);
    expect(routine?.observedAvgKcal).toBeCloseTo(400, 5);
  });

  it('creates a separate occurrence for a different date and keeps refining the average', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'rta', date: date2, reportedKcal: 500 });

    expect(result).toContain('réelle');

    // running average: (400*1 + 500) / 2 = 450
    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine test apply' } });
    expect(routine?.sampleCount).toBe(2);
    expect(routine?.observedAvgKcal).toBeCloseTo(450, 5);
  });

  it('tells the LLM to create the routine first when the name is unknown', async () => {
    const result = await handleApplyActivityRoutineTool({ routineName: 'routine inconnue xyz', date: date1 });
    expect(result).toContain('Aucune routine');
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/activityRoutine.test.ts`
Expected: FAIL — `handleApplyActivityRoutineTool` n'existe pas.

- [ ] **Step 3: Implémenter dans `lib/activityRoutine.ts`**

Ajouter l'import :

```ts
import { lookupMet, metToKcal, SPORT_DISCOUNTS, recomputeEventBonusForDate } from './activity.js';
```

(remplace la ligne d'import existante de `lib/activity.js` par celle-ci, qui ajoute `recomputeEventBonusForDate`.)

Ajouter à la fin du fichier :

```ts
export const APPLY_ACTIVITY_ROUTINE_TOOL: ToolDefinition = {
  name: 'apply_activity_routine',
  description:
    "Applique une routine d'activité déjà définie à une date donnée. " +
    "N'indique PAS reportedKcal si l'utilisateur annonce seulement qu'il va faire cette routine (application proactive, avant que ça ait eu lieu) — l'outil utilise alors la moyenne apprise ou l'estimation de départ. " +
    "Indique reportedKcal si l'utilisateur confirme une occurrence réelle avec un vrai total (ex: sa montre) — ça affine la moyenne de la routine pour la prochaine fois.",
  input_schema: {
    type: 'object',
    properties: {
      routineName: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      reportedKcal: { type: 'number' },
    },
    required: ['routineName', 'date'],
  },
};

export interface ApplyActivityRoutineInput {
  routineName: string;
  date: string;
  reportedKcal?: number;
}

export async function handleApplyActivityRoutineTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as ApplyActivityRoutineInput;

  const routine = await findRoutineByNameOrAlias(input.routineName);
  if (!routine) {
    return `Aucune routine nommée "${input.routineName}" n'est connue — demande à l'utilisateur de la décrire, puis crée-la avec define_activity_routine avant de réessayer.`;
  }

  const isReal = input.reportedKcal !== undefined;
  const effectiveKcal = input.reportedKcal ?? routine.observedAvgKcal ?? routine.estimatedKcal;
  const bonusKcal = effectiveKcal * (1 - routine.blendedDiscountPct);

  const existingPlanned = await prisma.activityLog.findFirst({
    where: { date: input.date, routineId: routine.id, status: 'planned' },
  });

  if (existingPlanned) {
    await prisma.activityLog.update({
      where: { id: existingPlanned.id },
      data: { reportedCalories: effectiveKcal, bonusKcal, status: isReal ? 'done' : 'planned' },
    });
  } else {
    await prisma.activityLog.create({
      data: {
        date: input.date,
        description: routine.name,
        sportType: routine.primarySportType ?? 'other',
        reportedCalories: effectiveKcal,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: effectiveKcal,
        discountPct: routine.blendedDiscountPct,
        bonusKcal,
        estimationMethod: isReal ? 'device' : 'met_estimate',
        routineId: routine.id,
        status: isReal ? 'done' : 'planned',
      },
    });
  }

  if (isReal) {
    const newSampleCount = routine.sampleCount + 1;
    const newAvg =
      ((routine.observedAvgKcal ?? routine.estimatedKcal) * routine.sampleCount + (input.reportedKcal as number)) /
      newSampleCount;
    await prisma.activityRoutine.update({
      where: { id: routine.id },
      data: { observedAvgKcal: newAvg, sampleCount: newSampleCount },
    });
  }

  await recomputeEventBonusForDate(input.date);

  const note = isReal ? 'confirmée avec le vrai total' : 'appliquée par anticipation (estimation)';
  return `Routine "${routine.name}" ${note} pour le ${input.date} : ${bonusKcal.toFixed(0)} kcal de bonus (rabais ${(routine.blendedDiscountPct * 100).toFixed(0)}%).`;
}
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/activityRoutine.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add lib/activityRoutine.ts tests/activityRoutine.test.ts
git commit -m "feat: add apply_activity_routine tool (proactive estimate or real confirmation)"
```

---

### Task 6: Câbler les deux outils dans le chat général (webhook)

**Files:**
- Modify: `api/telegram/webhook.ts`
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `DEFINE_ACTIVITY_ROUTINE_TOOL`, `handleDefineActivityRoutineTool`, `APPLY_ACTIVITY_ROUTINE_TOOL`, `handleApplyActivityRoutineTool` (Tasks 4-5, `lib/activityRoutine.js`).

- [ ] **Step 1: Mettre à jour les tests existants qui échoueront**

Dans `tests/webhook.test.ts`, ajouter l'import :

```ts
import { DEFINE_ACTIVITY_ROUTINE_TOOL, APPLY_ACTIVITY_ROUTINE_TOOL } from '../lib/activityRoutine.js';
```

Dans le test `"responds 200 and replies with Claude's answer from the allowed chat"`, mettre à jour le tableau d'outils attendu (ajouter les deux nouveaux outils avant `FLAG_CONCERN_TOOL`) :

```ts
      [
        ...scenariosLib.SCENARIO_TOOLS,
        SET_WEEKLY_SCHEDULE_TOOL,
        LOG_WEIGHT_TOOL,
        LOG_MEAL_TOOL,
        LOG_WEIGHED_MEAL_TOOL,
        SET_BODY_SCAN_TOOL,
        TRIGGER_REBASELINE_TOOL,
        LOG_ACTIVITY_TOOL,
        DEFINE_ACTIVITY_ROUTINE_TOOL,
        APPLY_ACTIVITY_ROUTINE_TOOL,
        FLAG_CONCERN_TOOL,
      ],
```

Faire le même remplacement dans le test `'downloads a PDF document, sends it to Claude with the body-scan prompt, and replies with the extraction'` (même tableau, même endroit).

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — les deux tests mis à jour ci-dessus échouent car le tableau réel ne contient pas encore les deux nouveaux outils.

- [ ] **Step 3: Implémenter dans `api/telegram/webhook.ts`**

Ajouter l'import (à la suite de l'import de `lib/activity.js`) :

```ts
import {
  DEFINE_ACTIVITY_ROUTINE_TOOL,
  APPLY_ACTIVITY_ROUTINE_TOOL,
  handleDefineActivityRoutineTool,
  handleApplyActivityRoutineTool,
} from '../../lib/activityRoutine.js';
```

Modifier `GENERAL_CHAT_TOOLS` :

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
  DEFINE_ACTIVITY_ROUTINE_TOOL,
  APPLY_ACTIVITY_ROUTINE_TOOL,
  FLAG_CONCERN_TOOL,
];
```

Modifier `handleGeneralChatTool` :

```ts
async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  if (name === 'log_weighed_meal') return handleLogWeighedMealTool(input);
  if (name === 'set_body_scan') return handleSetBodyScanTool(input);
  if (name === 'trigger_rebaseline') return handleTriggerRebaselineTool(input);
  if (name === 'log_activity') return handleLogActivityTool(input);
  if (name === 'define_activity_routine') return handleDefineActivityRoutineTool(input);
  if (name === 'apply_activity_routine') return handleApplyActivityRoutineTool(input);
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: wire define/apply_activity_routine into the general chat tools"
```

---

### Task 7: Étendre `log_activity` pour l'annonce anticipée générique

**Files:**
- Modify: `lib/activity.ts`
- Test: `tests/activity.test.ts`

**Interfaces:**
- Produces: `LogActivityInput.status?: 'done' | 'planned'`, `LogActivityInput.plannedTime?: string`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/activity.test.ts`, dans le `describe('handleLogActivityTool', ...)`, après le test de cumul de bonus (Task 2) :

```ts
  it('logs a planned (not-yet-done) activity ahead of time, applying the bonus proactively', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    const result = await handleLogActivityTool({
      date: dates[9],
      description: 'course prévue à midi',
      sportType: 'running',
      durationMinutes: 30,
      intensity: 'moderate',
      relationToPlan: 'additional',
      status: 'planned',
      plannedTime: '12:00',
    });

    expect(result).toContain('estimées');

    const log = await prisma.activityLog.findFirst({ where: { date: dates[9] } });
    expect(log?.status).toBe('planned');
    expect(log?.plannedTime).toBe('12:00');
  });

  it('updates the same planned entry in place when confirmed later instead of duplicating it', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(2500));
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);

    await handleLogActivityTool({
      date: dates[9],
      description: 'course confirmée',
      sportType: 'running',
      reportedCalories: 350,
      relationToPlan: 'additional',
    });

    const logs = await prisma.activityLog.findMany({ where: { date: dates[9], sportType: 'running' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('done');
    expect(logs[0].reportedCalories).toBe(350);
  });
```

Ajouter une 10ème date au tableau `dates` :

```ts
  const dates = ['1999-07-05', '1999-07-06', '1999-07-07', '1999-07-08', '1999-07-09', '1999-07-10', '1999-07-11', '1999-07-12', '1999-07-13', '1999-07-14'];
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/activity.test.ts`
Expected: FAIL — `status`/`plannedTime` non transmis au schéma Prisma, deux lignes créées au lieu d'une seule mise à jour en place.

- [ ] **Step 3: Implémenter dans `lib/activity.ts`**

Ajouter `status`/`plannedTime` à `LogActivityInput` :

```ts
export interface LogActivityInput {
  date: string;
  description: string;
  sportType: SportType;
  reportedCalories?: number;
  durationMinutes?: number;
  intensity?: Intensity;
  relationToPlan: 'replaces' | 'additional';
  status?: 'done' | 'planned';
  plannedTime?: string;
}
```

Ajouter les deux champs au schéma de `LOG_ACTIVITY_TOOL.input_schema.properties` :

```ts
      status: { type: 'string', enum: ['done', 'planned'], description: "'planned' si l'activité n'a pas encore eu lieu, annoncée à l'avance" },
      plannedTime: { type: 'string', description: "HH:MM, requis quand status = 'planned'" },
```

Remplacer le bloc de création/mise à jour d'`ActivityLog` (introduit à la Task 2) par :

```ts
  const status = input.status ?? 'done';

  const existingPlanned = await prisma.activityLog.findFirst({
    where: { date: input.date, sportType: input.sportType, routineId: null, status: 'planned' },
  });

  const activityData = {
    date: input.date,
    description: input.description,
    sportType: input.sportType,
    reportedCalories,
    relationToPlan: input.relationToPlan,
    baselineKcal,
    rawDiffKcal,
    discountPct,
    bonusKcal,
    intensity: input.intensity,
    durationMinutes: input.durationMinutes,
    estimationMethod,
    metUsed: metUsed ?? undefined,
    status,
    plannedTime: input.plannedTime,
  };

  if (existingPlanned) {
    await prisma.activityLog.update({ where: { id: existingPlanned.id }, data: activityData });
  } else {
    await prisma.activityLog.create({ data: activityData });
  }

  await recomputeEventBonusForDate(input.date);
```

(la variable `status` doit être déclarée avant le premier `return` anticipé du haut de la fonction — la placer juste après `const input = rawInput as unknown as LogActivityInput;`.)

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/activity.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add lib/activity.ts tests/activity.test.ts
git commit -m "feat: support announcing a planned activity ahead of time on log_activity"
```

---

### Task 8: Intégration onboarding

**Files:**
- Modify: `lib/onboarding.ts`
- Modify: `api/telegram/webhook.ts`
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `DEFINE_ACTIVITY_ROUTINE_TOOL`, `handleDefineActivityRoutineTool` (Task 4).

- [ ] **Step 1: Écrire le test qui échoue**

Dans `tests/webhook.test.ts`, modifier le test `'routes to the onboarding tool flow when onboarding basics are not yet saved'` — mettre à jour l'assertion sur les outils :

```ts
    expect(tools).toEqual([onboardingLib.ONBOARDING_TOOL, DEFINE_ACTIVITY_ROUTINE_TOOL, FLAG_CONCERN_TOOL]);
```

(remplace `expect(tools).toEqual([onboardingLib.ONBOARDING_TOOL, FLAG_CONCERN_TOOL]);`)

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — le tableau réel ne contient pas encore `DEFINE_ACTIVITY_ROUTINE_TOOL`.

- [ ] **Step 3: Implémenter**

Dans `lib/onboarding.ts`, remplacer la constante `ONBOARDING_SYSTEM_PROMPT` entière par :

```ts
export const ONBOARDING_SYSTEM_PROMPT = `Tu mènes la conversation d'onboarding de Raphaël, athlète d'endurance en volume élevé (8-10h/semaine).
Pose les questions une par une, en langage naturel, jusqu'à avoir : date de démarrage, poids actuel, taille, âge, sexe, poids cible, horizon souhaité en semaines, contraintes/aversions alimentaires, jour de pesée hebdo, jour du bilan, présence d'un jour de repos complet.
Une fois ces 11 informations réunies et avant de présenter le récapitulatif final, demande si l'utilisateur a des activités sportives régulières et prévisibles (même trajet, mêmes jours). Pour chacune, utilise l'outil define_activity_routine — ne l'appelle qu'après avoir confirmé le détail avec l'utilisateur, comme pour le reste de l'onboarding. Ce n'est pas obligatoire : s'il n'en a pas ou ne veut pas encore les décrire, n'insiste pas et continue vers le récapitulatif.
Une fois tous ces éléments réunis, présente un récapitulatif complet et demande explicitement une confirmation (une question, ex: "c'est bon pour toi, j'enregistre ?") — n'appelle pas encore l'outil à ce stade, attends la réponse de l'utilisateur.
Seulement après une confirmation explicite de l'utilisateur dans un message ultérieur, appelle l'outil record_onboarding_profile UNE SEULE FOIS avec toutes les valeurs.
Ne dis jamais "j'enregistre" ou une formule équivalente sans appeler l'outil dans ce même message — l'annonce et l'appel outil sont toujours simultanés, jamais l'un sans l'autre.
Ne calcule jamais toi-même de cible calorique ou de rythme de perte — c'est l'outil qui s'en charge.
Si l'outil retourne un refus, explique-le simplement, sans jugement, et oriente vers un professionnel de santé. N'insiste pas et ne propose aucune cible chiffrée dans ce cas.
Ton factuel, jamais moralisateur.`;
```

(seul changement vs l'original : la nouvelle phrase sur `define_activity_routine`, insérée entre la question des 11 champs et l'instruction de récapitulatif — tout le reste de la constante est identique à l'existant.)

Dans `api/telegram/webhook.ts`, modifier `handleOnboardingChatTool` :

```ts
async function handleOnboardingChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  if (name === 'define_activity_routine') return handleDefineActivityRoutineTool(input);
  return handleOnboardingTool(input);
}
```

Modifier l'appel `converseWithTool` de la branche onboarding dans `handleMessage` (le tableau d'outils `[ONBOARDING_TOOL, FLAG_CONCERN_TOOL]`) :

```ts
        [ONBOARDING_TOOL, DEFINE_ACTIVITY_ROUTINE_TOOL, FLAG_CONCERN_TOOL],
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add lib/onboarding.ts api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: allow defining activity routines during onboarding"
```

---

### Task 9: Application automatique du matin + notification à boutons

**Files:**
- Modify: `lib/activityRoutine.ts`
- Modify: `lib/notificationTick.ts`
- Test: `tests/notificationTick.test.ts`

**Interfaces:**
- Consumes: `sendMessageWithKeyboard`, `InlineKeyboardButton` (`lib/telegram.js`, déjà importés dans `notificationTick.ts`), `recordNotificationSent` (`lib/notificationStore.js`, déjà importé), `recomputeEventBonusForDate` (Task 2).
- Produces: `export async function getDueRoutinesToday(weekday: string, date: string)`, `export async function autoApplyRoutineForToday(routine, date: string): Promise<{ activityLogId: string; message: string }>` (`lib/activityRoutine.ts`) — utilisés par `runNotificationTick` et la Task 10.

- [ ] **Step 1: Écrire les tests qui échouent**

`prisma` est déjà importé en ligne 2 de `tests/notificationTick.test.ts` — aucun nouvel import nécessaire pour ça.

Modifier le bloc `afterAll` existant du fichier pour couvrir aussi les deux nouvelles dates de test :

```ts
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { date: TEST_DATE } });
    await prisma.dayPlan.deleteMany({ where: { date: TEST_DATE } });
    await prisma.weight.deleteMany({ where: { date: TEST_DATE } });
    await prisma.activityLog.deleteMany({ where: { date: { in: ['1998-04-06', '1998-04-13'] } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: ['1998-04-06', '1998-04-13'] } } });
    await prisma.activityRoutine.deleteMany({ where: { name: { in: ['aller au bureau test', 'routine déjà loggée'] } } });
  });
```

Ajouter, à la fin du `describe('runNotificationTick', ...)` (avant la fermeture) — le nettoyage se fait désormais uniquement via l'`afterAll` ci-dessus, pas de suppression inline en fin de test (pour survivre même si une assertion échoue en cours de test) :

```ts
  it('auto-applies a due recurring routine, sends a confirm/cancel prompt, and creates the planned ActivityLog', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1998-04-06T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();
    const sendKeyboardSpy = vi.spyOn(telegramLib, 'sendMessageWithKeyboard').mockResolvedValue();

    const routine = await prisma.activityRoutine.create({
      data: {
        name: 'aller au bureau test',
        aliases: [],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: ['monday'], // 1998-04-06 est un lundi
      },
    });

    const result = await runNotificationTick(new Date('1998-04-06T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).toContain(`routine_auto_apply:${routine.id}`);
    expect(sendKeyboardSpy).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('aller au bureau test'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Confirmer' }),
        expect.objectContaining({ text: "Pas aujourd'hui" }),
      ])
    );

    const log = await prisma.activityLog.findFirst({ where: { date: '1998-04-06', routineId: routine.id } });
    expect(log?.status).toBe('planned');
    expect(log?.bonusKcal).toBeCloseTo(240, 5); // 300 * (1-0.2)

    const dayPlan = await prisma.dayPlan.findFirst({ where: { date: '1998-04-06' } });
    expect(dayPlan?.eventBonusKcal).toBeCloseTo(240, 5);
  });

  it('does not re-apply a routine that already has a log for today', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile());
    vi.spyOn(weeklyScheduleStoreLib, 'getWeeklyDefault').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getMostRecentMeal').mockResolvedValue({ datetime: new Date('1998-04-13T07:00:00Z') });
    vi.spyOn(notificationStoreLib, 'getMostRecentDailyState').mockResolvedValue(null);
    vi.spyOn(notificationStoreLib, 'getRecentDailyStates').mockResolvedValue([]);
    vi.spyOn(sleepLib, 'recentSleepQualities').mockResolvedValue([]);
    vi.spyOn(telegramLib, 'sendMessage').mockResolvedValue();
    vi.spyOn(telegramLib, 'sendMessageWithKeyboard').mockResolvedValue();

    const routine = await prisma.activityRoutine.create({
      data: {
        name: 'routine déjà loggée',
        aliases: [],
        estimatedKcal: 300,
        blendedDiscountPct: 0.2,
        sampleCount: 0,
        recurringWeekdays: ['monday'], // 1998-04-13 est aussi un lundi
      },
    });
    await prisma.activityLog.create({
      data: {
        date: '1998-04-13',
        description: routine.name,
        sportType: 'other',
        reportedCalories: 300,
        relationToPlan: 'additional',
        baselineKcal: 0,
        rawDiffKcal: 300,
        discountPct: 0.2,
        bonusKcal: 240,
        routineId: routine.id,
        status: 'done',
      },
    });

    const result = await runNotificationTick(new Date('1998-04-13T06:30:00Z'), 12345);

    expect(result.sent.map((s) => s.rule)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('routine_auto_apply')])
    );
  });
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/notificationTick.test.ts`
Expected: FAIL — `getDueRoutinesToday`/`autoApplyRoutineForToday` n'existent pas, `runNotificationTick` ne les appelle pas encore.

- [ ] **Step 3: Implémenter**

Dans `lib/activityRoutine.ts`, ajouter à la fin du fichier :

```ts
export async function getDueRoutinesToday(weekday: string, date: string) {
  const routines = await prisma.activityRoutine.findMany({ where: { recurringWeekdays: { has: weekday } } });
  const due = [];
  for (const routine of routines) {
    const existing = await prisma.activityLog.findFirst({ where: { date, routineId: routine.id } });
    if (!existing) due.push(routine);
  }
  return due;
}

export async function autoApplyRoutineForToday(
  routine: { id: string; name: string; primarySportType: string | null; estimatedKcal: number; blendedDiscountPct: number; observedAvgKcal: number | null; timeRangeStart: string | null },
  date: string
): Promise<{ activityLogId: string; message: string }> {
  const effectiveKcal = routine.observedAvgKcal ?? routine.estimatedKcal;
  const bonusKcal = effectiveKcal * (1 - routine.blendedDiscountPct);

  const log = await prisma.activityLog.create({
    data: {
      date,
      description: routine.name,
      sportType: routine.primarySportType ?? 'other',
      reportedCalories: effectiveKcal,
      relationToPlan: 'additional',
      baselineKcal: 0,
      rawDiffKcal: effectiveKcal,
      discountPct: routine.blendedDiscountPct,
      bonusKcal,
      estimationMethod: 'met_estimate',
      routineId: routine.id,
      status: 'planned',
      plannedTime: routine.timeRangeStart,
    },
  });

  await recomputeEventBonusForDate(date);

  const message = `Aujourd'hui, tu fais normalement "${routine.name}" — cible du jour ajustée de +${bonusKcal.toFixed(0)} kcal (estimation). Dis-moi si ce n'est pas le cas.`;

  return { activityLogId: log.id, message };
}

export async function cancelPlannedActivity(activityLogId: string): Promise<boolean> {
  const log = await prisma.activityLog.findUnique({ where: { id: activityLogId } });
  if (!log) return false;
  await prisma.activityLog.delete({ where: { id: activityLogId } });
  await recomputeEventBonusForDate(log.date);
  return true;
}
```

Dans `lib/notificationTick.ts`, ajouter l'import :

```ts
import { getDueRoutinesToday, autoApplyRoutineForToday } from './activityRoutine.js';
```

Remplacer le corps entier de `runNotificationTick` par :

```ts
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
  const sent: { rule: string; message: string }[] = [];

  const dueRoutines = await getDueRoutinesToday(weekday, dateIso);
  if (dueRoutines.length > 0 && sentCount < MAX_NOTIFICATIONS_PER_DAY) {
    const routine = dueRoutines[0];
    const { activityLogId, message } = await autoApplyRoutineForToday(routine, dateIso);
    await sendMessageWithKeyboard(chatId, message, [
      { text: 'Confirmer', callback_data: `routine:confirm:${activityLogId}` },
      { text: "Pas aujourd'hui", callback_data: `routine:cancel:${activityLogId}` },
    ]);
    const rule = `routine_auto_apply:${routine.id}`;
    await recordNotificationSent(dateIso, rule);
    sent.push({ rule, message });
    sentCount++;
  }

  const [profile, weeklyDefault, todayWeight, todayDayPlan, latestMeal, latestDailyState, recentDailyStates, sleepQualities] =
    await Promise.all([
      getProfileSnapshot(),
      getWeeklyDefault(weekday),
      prisma.weight.findUnique({ where: { date: dateIso } }),
      prisma.dayPlan.findUnique({ where: { date: dateIso } }),
      getMostRecentMeal(),
      getMostRecentDailyState(),
      getRecentDailyStates(WEEKLY_WINDOW_DAYS),
      recentSleepQualities(WEEKLY_WINDOW_DAYS),
    ]);

  const latestMealAgeHours = latestMeal ? (now.getTime() - latestMeal.datetime.getTime()) / (1000 * 60 * 60) : null;

  const proteinTarget = profile.weightKg !== null ? proteinTargetRangeG(profile.weightKg) : null;
  const weeklyMacros: WeeklyMacros | null = proteinTarget
    ? { entries: recentDailyStates, proteinTargetMinG: proteinTarget.minG, proteinTargetMaxG: proteinTarget.maxG }
    : null;

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
    weeklyMacros,
    recentSleepQualities: sleepQualities,
  };

  for (const rule of NOTIFICATION_RULES) {
    if (sentCount >= MAX_NOTIFICATIONS_PER_DAY) break;
    const result = await rule(context);
    if (!result) continue;
    if (await hasRuleFiredToday(dateIso, result.rule)) continue;

    if (result.buttons) {
      await sendMessageWithKeyboard(chatId, result.message, result.buttons);
    } else {
      await sendMessage(chatId, result.message);
    }
    await recordNotificationSent(dateIso, result.rule);
    sent.push(result);
    sentCount++;
  }

  return { sent, skippedQuietHours: false };
}
```

(seul changement vs l'original : la déclaration de `sent` est remontée juste après `weekday`, et le nouveau bloc de traitement des routines dues s'insère avant le `Promise.all` existant — tout le reste de la fonction, y compris la boucle `NOTIFICATION_RULES`, est inchangé.)

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/notificationTick.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck et commit**

Run: `npx tsc --noEmit`

```bash
git add lib/activityRoutine.ts lib/notificationTick.ts tests/notificationTick.test.ts
git commit -m "feat: auto-apply due recurring routines each morning with a confirm/cancel prompt"
```

---

### Task 10: Traiter les boutons Confirmer / Pas aujourd'hui

**Files:**
- Modify: `api/telegram/webhook.ts`
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `cancelPlannedActivity` (Task 9, `lib/activityRoutine.js`).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/webhook.test.ts`, dans les imports :

```ts
import * as activityRoutineLib from '../lib/activityRoutine.js';
```

Ajouter, après le test `'ignores a callback query from another chat'`, avant la fermeture du `describe` principal :

```ts
  it('acknowledges a routine confirmation callback without changing anything', async () => {
    const answerSpy = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const cancelSpy = vi.spyOn(activityRoutineLib, 'cancelPlannedActivity');
    const res = mockRes();
    const body = {
      callback_query: { id: 'cq2', data: 'routine:confirm:abc123', message: { chat: { id: 12345 } } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(answerSpy).toHaveBeenCalledWith('cq2');
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.any(String));
  });

  it('cancels a planned routine activity when "Pas aujourd\'hui" is tapped', async () => {
    const answerSpy = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const cancelSpy = vi.spyOn(activityRoutineLib, 'cancelPlannedActivity').mockResolvedValue(true);
    const res = mockRes();
    const body = {
      callback_query: { id: 'cq3', data: 'routine:cancel:abc123', message: { chat: { id: 12345 } } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(answerSpy).toHaveBeenCalledWith('cq3');
    expect(cancelSpy).toHaveBeenCalledWith('abc123');
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('annulé'));
  });
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — `handleCallbackQuery` ne reconnaît pas encore le préfixe `routine:`.

- [ ] **Step 3: Implémenter dans `api/telegram/webhook.ts`**

Ajouter l'import `cancelPlannedActivity` à la ligne d'import de `lib/activityRoutine.js` (Task 6) :

```ts
import {
  DEFINE_ACTIVITY_ROUTINE_TOOL,
  APPLY_ACTIVITY_ROUTINE_TOOL,
  handleDefineActivityRoutineTool,
  handleApplyActivityRoutineTool,
  cancelPlannedActivity,
} from '../../lib/activityRoutine.js';
```

Modifier `handleCallbackQuery` :

```ts
async function handleCallbackQuery(cq: { callbackQueryId: string; chatId: number; data: string }): Promise<void> {
  await answerCallbackQuery(cq.callbackQueryId);

  if (cq.data.startsWith('sleep:')) {
    const quality = cq.data.slice('sleep:'.length);
    if (SLEEP_QUALITIES.includes(quality as SleepQuality)) {
      await saveSleepQuality(todayIsoDate(), quality as SleepQuality);
      await sendMessage(cq.chatId, `Nuit notée : ${quality}.`);
    }
    return;
  }

  if (cq.data.startsWith('routine:confirm:')) {
    await sendMessage(cq.chatId, 'Ok, noté.');
    return;
  }

  if (cq.data.startsWith('routine:cancel:')) {
    const activityLogId = cq.data.slice('routine:cancel:'.length);
    await cancelPlannedActivity(activityLogId);
    await sendMessage(cq.chatId, "Ok, annulé pour aujourd'hui.");
  }
}
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Lancer toute la suite, typecheck, commit**

Run: `npx vitest run`
Expected: tous les tests passent (le flake préexistant sur `tests/sleep.test.ts`, sans rapport avec ce plan, peut subsister).

Run: `npx tsc --noEmit`

```bash
git add api/telegram/webhook.ts tests/webhook.test.ts
git commit -m "feat: handle routine confirm/cancel callback buttons"
```

---

## Auto-Review (fait par l'auteur du plan)

- **Couverture de la spec** : modèle de données (Task 3), marche + helpers MET (Task 1), bug de cumul (Task 2), estimation initiale par legs/kcal connu (Task 4), application proactive/réelle + moyenne (Task 5), câblage chat général (Task 6), annonce anticipée générique sur `log_activity` (Task 7), onboarding (Task 8), planning récurrent + notification + boutons (Task 9), callbacks confirm/cancel (Task 10). Tout couvert.
- **Cohérence des types** : `SportType` (Task 1) inclut `'walking'` partout où il est réutilisé (Tasks 4, 5, 9) ; `recomputeEventBonusForDate` (Task 2) a la même signature partout où elle est importée (Tasks 5, 7, 9, 10) ; `status`/`plannedTime` (Task 3 schéma, Task 7 usage) correspondent.
- **Aucun placeholder** : chaque étape contient le code exact à écrire, pas de "voir Task N" ni de TODO.
