import { shouldRefuseProgram } from './calc/guardrails.js';
import { resolveGoal, proteinTargetRangeG } from './calc/baseline.js';
import { saveOnboardingProfile, isEdSignalFlagged } from './profile.js';
import type { ToolDefinition } from './claude.js';

export const ONBOARDING_TOOL: ToolDefinition = {
  name: 'record_onboarding_profile',
  description:
    "Enregistre le profil d'onboarding une fois que tous les champs ont été confirmés avec l'utilisateur. À appeler une seule fois, à la fin de la conversation d'onboarding.",
  input_schema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Date de démarrage, format YYYY-MM-DD' },
      weightKg: { type: 'number' },
      heightCm: { type: 'number' },
      age: { type: 'integer' },
      sex: { type: 'string', enum: ['male', 'female'] },
      targetWeightKg: { type: 'number' },
      targetWeeks: { type: 'integer' },
      constraints: { type: 'array', items: { type: 'string' } },
      weighInDay: { type: 'string' },
      reviewDay: { type: 'string' },
      restDayPresent: { type: 'boolean' },
    },
    required: [
      'startDate',
      'weightKg',
      'heightCm',
      'age',
      'sex',
      'targetWeightKg',
      'targetWeeks',
      'constraints',
      'weighInDay',
      'reviewDay',
      'restDayPresent',
    ],
  },
};

export const ONBOARDING_SYSTEM_PROMPT = `Tu mènes la conversation d'onboarding de Raphaël, athlète d'endurance en volume élevé (8-10h/semaine).
Pose les questions une par une, en langage naturel, jusqu'à avoir : date de démarrage, poids actuel, taille, âge, sexe, poids cible, horizon souhaité en semaines, contraintes/aversions alimentaires, jour de pesée hebdo, jour du bilan, présence d'un jour de repos complet.
Une fois TOUS ces éléments confirmés avec l'utilisateur, appelle l'outil record_onboarding_profile UNE SEULE FOIS avec toutes les valeurs.
Ne calcule jamais toi-même de cible calorique ou de rythme de perte — c'est l'outil qui s'en charge.
Si l'outil retourne un refus, explique-le simplement, sans jugement, et oriente vers un professionnel de santé. N'insiste pas et ne propose aucune cible chiffrée dans ce cas.
Ton factuel, jamais moralisateur.`;

export interface OnboardingInput {
  startDate: string;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
  targetWeightKg: number;
  targetWeeks: number;
  constraints: string[];
  weighInDay: string;
  reviewDay: string;
  restDayPresent: boolean;
}

export type OnboardingDecision =
  | { refused: true }
  | {
      refused: false;
      ratePctPerWeek: number;
      weeks: number;
      adjusted: boolean;
      proteinMinG: number;
      proteinMaxG: number;
    };

export function resolveOnboardingDecision(input: OnboardingInput): OnboardingDecision {
  if (shouldRefuseProgram(input.weightKg, input.targetWeightKg, input.heightCm)) {
    return { refused: true };
  }

  const goal = resolveGoal({
    currentWeightKg: input.weightKg,
    targetWeightKg: input.targetWeightKg,
    requestedWeeks: input.targetWeeks,
  });
  const protein = proteinTargetRangeG(input.weightKg);

  return {
    refused: false,
    ratePctPerWeek: goal.ratePctPerWeek,
    weeks: goal.weeks,
    adjusted: goal.adjusted,
    proteinMinG: protein.minG,
    proteinMaxG: protein.maxG,
  };
}

export async function handleOnboardingTool(rawInput: Record<string, unknown>): Promise<string> {
  if (await isEdSignalFlagged()) {
    return "Un signal de préoccupation a déjà été noté précédemment. N'annonce aucune cible chiffrée pour l'instant ; exprime ton inquiétude avec bienveillance et oriente vers un professionnel de santé.";
  }

  const input = rawInput as unknown as OnboardingInput;
  const decision = resolveOnboardingDecision(input);

  if (decision.refused) {
    return "REFUS : l'IMC actuel ou l'IMC cible est sous le seuil de sécurité (18.5). N'annonce aucune cible chiffrée, oriente vers un professionnel de santé, avec bienveillance.";
  }

  await saveOnboardingProfile(input, decision);

  const horizonNote = decision.adjusted
    ? `L'horizon a été allongé à ${decision.weeks} semaines pour rester sous le rythme de perte maximal (0.75%/semaine) — le déficit n'a pas été creusé.`
    : `Rythme et horizon demandés acceptés tels quels (${decision.weeks} semaines).`;

  return [
    'Profil enregistré avec succès.',
    horizonNote,
    `Rythme cible retenu : ${decision.ratePctPerWeek.toFixed(2)}% du poids/semaine.`,
    `Cible protéines : ${decision.proteinMinG.toFixed(0)}-${decision.proteinMaxG.toFixed(0)} g/jour.`,
    "Aucune cible calorique n'est fixée pour l'instant : il manque le scan de composition corporelle (prérequis bloquant). Dis à l'utilisateur d'envoyer la photo/PDF du scan dès qu'il l'aura.",
  ].join(' ');
}
