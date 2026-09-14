import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as profileLib from '../lib/profile.js';
import { resolveOnboardingDecision, handleOnboardingTool, ONBOARDING_SYSTEM_PROMPT } from '../lib/onboarding.js';
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
    vi.spyOn(profileLib, 'isEdSignalFlagged').mockResolvedValue(false);
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

  it('refuses to give a numeric target when an ED signal was previously flagged', async () => {
    vi.spyOn(profileLib, 'isEdSignalFlagged').mockResolvedValue(true);
    const saveSpy = vi.spyOn(profileLib, 'saveOnboardingProfile').mockResolvedValue();

    const result = await handleOnboardingTool({ ...baseInput });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(result).not.toMatch(/\d/);
  });
});

describe('ONBOARDING_SYSTEM_PROMPT', () => {
  it('asks about activity routines only after the profile has been recorded', () => {
    // define_activity_routine needs the weight from the DB (MET path), and only
    // record_onboarding_profile creates the Profile row — so the routine question must come after it.
    const recordIndex = ONBOARDING_SYSTEM_PROMPT.indexOf('record_onboarding_profile');
    const routineIndex = ONBOARDING_SYSTEM_PROMPT.indexOf('define_activity_routine');

    expect(recordIndex).toBeGreaterThan(-1);
    expect(routineIndex).toBeGreaterThan(-1);
    expect(routineIndex).toBeGreaterThan(recordIndex);
  });

  it('still asks for an explicit confirmation before calling the tool', () => {
    const recapIndex = ONBOARDING_SYSTEM_PROMPT.indexOf("c'est bon pour toi, j'enregistre ?");
    const recordIndex = ONBOARDING_SYSTEM_PROMPT.indexOf('record_onboarding_profile UNE SEULE FOIS');

    expect(recapIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(recapIndex);
  });
});
