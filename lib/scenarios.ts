import type { Prisma } from '@prisma/client';
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
      segments: input.segments as unknown as Prisma.InputJsonValue,
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
  const segmentsResolvedJson = segmentsResolved as unknown as Prisma.InputJsonValue;

  await prisma.dayPlan.upsert({
    where: { date: input.date },
    create: {
      date: input.date,
      scenariosApplied: found.map((s) => s.id),
      segmentsResolved: segmentsResolvedJson,
      confirmed: true,
      isAtypical: input.isAtypical,
    },
    update: {
      scenariosApplied: found.map((s) => s.id),
      segmentsResolved: segmentsResolvedJson,
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
          segmentsResolved: implied.segments as unknown as Prisma.InputJsonValue,
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
