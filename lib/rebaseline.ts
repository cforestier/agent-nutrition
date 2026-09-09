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
