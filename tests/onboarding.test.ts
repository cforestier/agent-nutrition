import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as profileLib from '../lib/profile.js';
import { resolveOnboardingDecision, handleOnboardingTool } from '../lib/onboarding.js';
import type { OnboardingInput } from '../lib/onboarding.js';

const baseInput: OnboardingInput = {
  startDate: '2026-09-10',
  weightKg: 80,
  heightCm: 180,
  age: 30,
  sex: 'male',
  targetWeightKg: 74,
  targetWeeks: 12,
  constraints: [],
  weighInDay: 'monday',
  reviewDay: 'sunday',
  restDayPresent: true,
};

describe('resolveOnboardingDecision', () => {
  it('refuses when BMI would go below the floor', () => {
    const decision = resolveOnboardingDecision({ ...baseInput, weightKg: 50, heightCm: 175, targetWeightKg: 48 });
    expect(decision).toEqual({ refused: true });
  });

  it('accepts the requested rate when under the cap', () => {
    const decision = resolveOnboardingDecision(baseInput);
    expect(decision.refused).toBe(false);
    if (!decision.refused) {
      expect(decision.adjusted).toBe(false);
      expect(decision.weeks).toBe(12);
      expect(decision.proteinMinG).toBeCloseTo(160, 5);
      expect(decision.proteinMaxG).toBeCloseTo(176, 5);
    }
  });

  it('lengthens the horizon when the requested rate exceeds the cap', () => {
    const decision = resolveOnboardingDecision({ ...baseInput, targetWeightKg: 70, targetWeeks: 8 });
    expect(decision.refused).toBe(false);
    if (!decision.refused) {
      expect(decision.adjusted).toBe(true);
      expect(decision.weeks).toBe(17);
    }
  });
});

describe('handleOnboardingTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('saves the profile and returns a confirmation message when accepted', async () => {
    const saveSpy = vi.spyOn(profileLib, 'saveOnboardingProfile').mockResolvedValue();

    const result = await handleOnboardingTool({ ...baseInput });

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ weightKg: 80, targetWeightKg: 74 }),
      expect.objectContaining({ refused: false, weeks: 12 })
    );
    expect(result).toContain('Profil enregistré');
    expect(result).toContain('scan de composition corporelle');
  });

  it('does not save anything and returns a refusal message when BMI is below the floor', async () => {
    const saveSpy = vi.spyOn(profileLib, 'saveOnboardingProfile').mockResolvedValue();

    const result = await handleOnboardingTool({ ...baseInput, weightKg: 50, heightCm: 175, targetWeightKg: 48 });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(result).toContain('REFUS');
  });
});
