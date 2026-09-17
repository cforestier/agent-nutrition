import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { searchFoodCandidates } from './foods.js';
import { normalizeFoodName, tokenizeFoodName } from './ciqualParser.js';
import type { ToolDefinition } from './claude.js';

export interface MealItem {
  name: string;
  estimatedGrams: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface MealItemInput extends MealItem {
  confirmDuplicate?: boolean;
}

export interface LogMealInput {
  rawDescription: string;
  items: MealItemInput[];
  kcalLow: number;
  kcalMid: number;
  kcalHigh: number;
}

export const LOG_MEAL_TOOL: ToolDefinition = {
  name: 'log_meal',
  description:
    "Enregistre un repas décrit en langage naturel, SANS grammage précis (ex: \"une assiette de pâtes bolognaise\"). Estime les aliments, leurs macronutriments, et donne TOUJOURS une fourchette calorique (kcalLow/kcalMid/kcalHigh) — jamais un chiffre unique, l'estimation par description reste approximative. Si l'utilisateur donne un grammage précis pour chaque aliment, utilise log_weighed_meal à la place. " +
    "Si un aliment est signalé comme doublon possible (déjà mangé récemment) et que l'utilisateur confirme que c'est bien une portion supplémentaire, rappelle l'outil avec confirmDuplicate: true sur cet aliment.",
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
            confirmDuplicate: {
              type: 'boolean',
              description:
                "Mets true UNIQUEMENT si l'utilisateur a explicitement confirmé qu'un aliment signalé comme doublon possible est une nouvelle portion.",
            },
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

// A meal conversation can span several Telegram messages while Claude asks clarifying questions
// (food type, cooking state, grammage...). Each incoming message is handled as an independent,
// stateless tool call, and Claude is told to resend only the newly-clarified foods — but in
// practice it sometimes resends foods that were already saved too, so this data-layer state
// machine catches it instead of relying purely on that prompt instruction.
//
// Two distinct situations need two different behaviors, which is why a single "same text within
// N minutes" check (the previous approach) wasn't enough:
//   1. The current meal is still being clarified (some foods were ambiguous/not found) -> a
//      resent food that was already saved this session is a silent duplicate, drop it.
//   2. The previous meal was already fully resolved, and the same food reappears within
//      DUPLICATE_CONFIRM_WINDOW_MINUTES -> that's plausibly a real second portion (e.g. seconds
//      helpings, a snack repeated later), so ask for confirmation instead of guessing.
const SESSION_WINDOW_MINUTES = 20;
const DUPLICATE_CONFIRM_WINDOW_MINUTES = 30;

// A session is only reused when the incoming call's food terms actually overlap with what that
// session is still waiting to clarify. Matching purely on "most recently opened session" would
// wrongly glue together two unrelated meals if the user starts describing a new one before
// answering an outstanding clarification question about the previous one (e.g. leaves "what kind
// of bread?" unanswered and moves straight to describing dinner) — any food name the two meals
// happen to share would then be silently treated as an already-logged resend instead of being
// evaluated as its own (possibly duplicate) entry.
async function getSessionId(candidateTexts: string[]): Promise<string> {
  const cutoff = new Date(Date.now() - SESSION_WINDOW_MINUTES * 60 * 1000);
  const candidateTokens = new Set(candidateTexts.flatMap(tokenizeFoodName));
  const openSessions = await prisma.mealSession.findMany({
    where: { isOpen: true, updatedAt: { gte: cutoff } },
    orderBy: { updatedAt: 'desc' },
  });
  const match = openSessions.find((s) => s.pendingQueries.some((t) => candidateTokens.has(t)));
  return match?.sessionId ?? randomUUID();
}

async function closeOrReopenSession(sessionId: string, pendingQueryTexts: string[]): Promise<void> {
  const pendingQueries = [...new Set(pendingQueryTexts.flatMap(tokenizeFoodName))];
  await prisma.mealSession.upsert({
    where: { sessionId },
    create: { sessionId, isOpen: pendingQueries.length > 0, pendingQueries },
    update: { isOpen: pendingQueries.length > 0, pendingQueries },
  });
}

interface PossibleDuplicate {
  name: string;
  minutesAgo: number;
}

interface DedupResult {
  toSave: MealItem[];
  duplicateWithinSessionCount: number;
  possibleDuplicates: PossibleDuplicate[];
}

async function splitByDuplicateStatus(sessionId: string, items: MealItemInput[]): Promise<DedupResult> {
  const sessionMeals = await prisma.meal.findMany({ where: { sessionId } });
  const namesAlreadyInSession = new Set(
    sessionMeals.flatMap((m) => (m.items as unknown as MealItem[]).map((i) => normalizeFoodName(i.name)))
  );

  const dupCutoff = new Date(Date.now() - DUPLICATE_CONFIRM_WINDOW_MINUTES * 60 * 1000);
  const recentMeals = await prisma.meal.findMany({ where: { createdAt: { gte: dupCutoff } } });
  const lastLoggedAtByName = new Map<string, Date>();
  for (const meal of recentMeals) {
    for (const item of meal.items as unknown as MealItem[]) {
      const key = normalizeFoodName(item.name);
      const existing = lastLoggedAtByName.get(key);
      if (!existing || meal.createdAt > existing) lastLoggedAtByName.set(key, meal.createdAt);
    }
  }

  const toSave: MealItem[] = [];
  const possibleDuplicates: PossibleDuplicate[] = [];
  let duplicateWithinSessionCount = 0;

  for (const { confirmDuplicate, ...item } of items) {
    const key = normalizeFoodName(item.name);

    if (namesAlreadyInSession.has(key)) {
      duplicateWithinSessionCount++;
      continue;
    }

    const lastLoggedAt = lastLoggedAtByName.get(key);
    if (lastLoggedAt && !confirmDuplicate) {
      const minutesAgo = Math.max(0, Math.round((Date.now() - lastLoggedAt.getTime()) / 60000));
      possibleDuplicates.push({ name: item.name, minutesAgo });
      continue;
    }

    toSave.push(item);
  }

  return { toSave, duplicateWithinSessionCount, possibleDuplicates };
}

function possibleDuplicatesNote(possibleDuplicates: PossibleDuplicate[]): string {
  if (possibleDuplicates.length === 0) return '';
  return possibleDuplicates
    .map(
      (d) =>
        `"${d.name}" a déjà été enregistré il y a ${d.minutesAgo} min : c'est une portion supplémentaire ? Si oui, redemande-le avec confirmDuplicate.`
    )
    .join(' ');
}

export async function handleLogMealTool(rawInput: Record<string, unknown>): Promise<string> {
  const input = rawInput as unknown as LogMealInput;

  const sessionId = await getSessionId(input.items.map((i) => i.name));
  const { toSave, duplicateWithinSessionCount, possibleDuplicates } = await splitByDuplicateStatus(
    sessionId,
    input.items
  );

  let savedNote = '';
  if (toSave.length > 0) {
    await prisma.meal.create({
      data: {
        inputType: 'text',
        rawDescription: input.rawDescription,
        items: toSave as unknown as Prisma.InputJsonValue,
        kcalLow: input.kcalLow,
        kcalMid: input.kcalMid,
        kcalHigh: input.kcalHigh,
        confidence: 'medium',
        userCorrected: false,
        sessionId,
      },
    });
    savedNote = `Repas enregistré : ${input.kcalLow}-${input.kcalHigh} kcal (estimation ~${input.kcalMid} kcal), confiance moyenne.`;
  }

  if (duplicateWithinSessionCount > 0) {
    savedNote +=
      (savedNote ? ' ' : '') +
      `${duplicateWithinSessionCount} aliment(s) déjà enregistré(s) pour ce même repas, ignoré(s) pour éviter un doublon.`;
  }

  // log_meal has no ambiguous/not-found clarification loop, so it never has a reason to keep a
  // session open for a later resend — only the cross-meal duplicate check (independent of session
  // continuity) applies here.
  await closeOrReopenSession(sessionId, []);

  const dupNote = possibleDuplicatesNote(possibleDuplicates);
  return [savedNote, dupNote].filter(Boolean).join(' ');
}

export interface WeighedMealItemInput {
  foodQuery: string;
  grams: number;
  confirmDuplicate?: boolean;
}

export interface LogWeighedMealInput {
  rawDescription: string;
  items: WeighedMealItemInput[];
}

export const LOG_WEIGHED_MEAL_TOOL: ToolDefinition = {
  name: 'log_weighed_meal',
  description:
    "Enregistre un repas pesé, quand l'utilisateur donne un grammage précis pour chaque aliment (ex: \"200g de riz basmati cuit, 150g de poulet\"). Ne calcule JAMAIS toi-même les calories ou macros : donne uniquement le nom de chaque aliment tel que décrit et son poids en grammes, l'outil fait la recherche dans la base Ciqual et le calcul exact. " +
    "Les aliments non ambigus sont enregistrés immédiatement, même si d'autres aliments du même message posent question — seuls les aliments encore à clarifier sont renvoyés dans la réponse. Pose la question à l'utilisateur UNIQUEMENT sur ceux-là, puis rappelle l'outil avec seulement ces aliments précisés (ne réinclus pas ceux déjà enregistrés, sous peine de les compter deux fois). " +
    "Si un aliment est signalé comme doublon possible (déjà mangé récemment) et que l'utilisateur confirme que c'est bien une portion supplémentaire, rappelle l'outil avec confirmDuplicate: true sur cet aliment.",
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
            confirmDuplicate: {
              type: 'boolean',
              description:
                "Mets true UNIQUEMENT si l'utilisateur a explicitement confirmé qu'un aliment signalé comme doublon possible est une nouvelle portion.",
            },
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

  const resolvedItems: MealItemInput[] = [];
  const notFound: string[] = [];
  const ambiguous: { query: string; candidateNames: string[] }[] = [];

  for (const item of input.items) {
    const candidates = await searchFoodCandidates(item.foodQuery);

    if (candidates.length === 0) {
      notFound.push(item.foodQuery);
      continue;
    }

    // Token-set equality rather than literal string equality: Ciqual names are comma-separated
    // ("Poulet, blanc, cuit") so a natural-phrase query never equals them character-for-character
    // even when it names exactly that food and nothing else.
    const queryTokens = new Set(tokenizeFoodName(item.foodQuery));
    const exactMatch = candidates.find((c) => {
      const candidateTokens = tokenizeFoodName(c.name);
      return candidateTokens.length === queryTokens.size && candidateTokens.every((t) => queryTokens.has(t));
    });
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
      confirmDuplicate: item.confirmDuplicate,
    });
  }

  const sessionId = await getSessionId(input.items.map((i) => i.foodQuery));
  const { toSave, duplicateWithinSessionCount, possibleDuplicates } = await splitByDuplicateStatus(
    sessionId,
    resolvedItems
  );

  // Resolved items are saved right away rather than held back until every item in the message
  // resolves — otherwise a single ambiguous/unmatched food (e.g. several Ciqual entries for
  // "pâtes") blocks logging of the clear ones too (e.g. "pastèque"), forcing the model to keep
  // the whole meal in conversation memory across the clarification back-and-forth instead of
  // just resolving the one food that actually needs it.
  let savedNote = '';
  if (toSave.length > 0) {
    const totalKcal = toSave.reduce((sum, i) => sum + i.kcal, 0);

    await prisma.meal.create({
      data: {
        inputType: 'text',
        rawDescription: input.rawDescription,
        items: toSave as unknown as Prisma.InputJsonValue,
        kcalLow: totalKcal,
        kcalMid: totalKcal,
        kcalHigh: totalKcal,
        confidence: 'high',
        userCorrected: false,
        sessionId,
      },
    });

    savedNote = `Repas pesé enregistré : ${totalKcal.toFixed(0)} kcal (${toSave.length} aliment(s), confiance haute — lookup Ciqual).`;
  }

  if (duplicateWithinSessionCount > 0) {
    savedNote +=
      (savedNote ? ' ' : '') +
      `${duplicateWithinSessionCount} aliment(s) déjà enregistré(s) pour ce même repas, ignoré(s) pour éviter un doublon.`;
  }

  await closeOrReopenSession(sessionId, [...ambiguous.map((a) => a.query), ...notFound]);

  const dupNote = possibleDuplicatesNote(possibleDuplicates);
  if (dupNote) savedNote += (savedNote ? ' ' : '') + dupNote;

  if (notFound.length > 0 || ambiguous.length > 0) {
    const parts: string[] = [];
    if (savedNote) parts.push(savedNote);
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

  return savedNote;
}
