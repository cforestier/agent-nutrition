import { flagEdSignal } from './profile.js';
import type { ToolDefinition } from './claude.js';

export const FLAG_CONCERN_TOOL: ToolDefinition = {
  name: 'flag_concern',
  description:
    "Signale un motif de préoccupation lié au comportement alimentaire (restriction excessive, culpabilité alimentaire marquée, comportements compensatoires, obsession du chiffre). Une fois appelé, l'agent cesse de donner des cibles chiffrées de façon persistante. N'appelle cet outil que face à un signal réel et répété, jamais à la légère.",
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Description brève et factuelle du signal observé' },
    },
    required: ['reason'],
  },
};

export const SAFETY_GUARDRAILS_PROMPT = `

Garde-fous non négociables :
- Si le langage de l'utilisateur suggère une restriction excessive, une culpabilité alimentaire marquée, des comportements compensatoires ou une obsession du chiffre : appelle flag_concern, cesse de donner des cibles chiffrées, exprime ton inquiétude simplement, oriente vers un professionnel de santé. Ne diagnostique jamais.
- Aucun conseil médical : n'interprète pas de symptômes, ne recommande aucun complément au-delà des bases, ne donne aucun avis sur des médicaments. Oriente systématiquement vers un professionnel pour ces sujets.`;

export async function handleFlagConcernTool(rawInput: Record<string, unknown>): Promise<string> {
  const { reason } = rawInput as unknown as { reason: string };
  await flagEdSignal(reason);
  return "Signalement enregistré, de façon persistante. À partir de maintenant, n'annonce plus aucune cible chiffrée (calories, rythme, macros) : exprime ta préoccupation simplement, sans jugement, et oriente vers un professionnel de santé. Ne diagnostique rien.";
}
