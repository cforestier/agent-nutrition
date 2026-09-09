import { describe, it, expect } from 'vitest';
import {
  clampToFloor,
  shouldRefuseProgram,
  isRapidLossAlert,
  isRedsAlert,
  needsRestDayWarning,
} from '../../lib/calc/guardrails.js';

describe('clampToFloor', () => {
  it('raises the target up to the floor when below it', () => {
    expect(clampToFloor(2050, 2100)).toBe(2100);
  });

  it('leaves the target untouched when already above the floor', () => {
    expect(clampToFloor(2200, 2100)).toBe(2200);
  });
});

describe('shouldRefuseProgram', () => {
  it('refuses when the current weight is already below the BMI floor', () => {
    expect(shouldRefuseProgram(50, 48, 175)).toBe(true);
  });

  it('refuses when the target weight would lead below the BMI floor', () => {
    expect(shouldRefuseProgram(70, 55, 175)).toBe(true);
  });

  it('allows the program when both weights stay above the BMI floor', () => {
    expect(shouldRefuseProgram(70, 65, 175)).toBe(false);
  });
});

describe('isRapidLossAlert', () => {
  it('alerts above 1% body weight lost over the week', () => {
    expect(isRapidLossAlert(80, 79)).toBe(true); // 1.25%
  });

  it('does not alert at exactly 1%', () => {
    expect(isRapidLossAlert(100, 99)).toBe(false);
  });

  it('does not alert under 1%', () => {
    expect(isRapidLossAlert(80, 79.5)).toBe(false);
  });
});

describe('isRedsAlert', () => {
  it('alerts only when all four signals are present', () => {
    expect(
      isRedsAlert({ highVolume: true, inDeficit: true, performanceDeclining: true, highFatigue: true })
    ).toBe(true);
  });

  it('does not alert when any signal is missing', () => {
    expect(
      isRedsAlert({ highVolume: true, inDeficit: true, performanceDeclining: false, highFatigue: true })
    ).toBe(false);
  });
});

describe('needsRestDayWarning', () => {
  it('is false under 10 consecutive days without a full rest day', () => {
    expect(needsRestDayWarning(9)).toBe(false);
  });

  it('is true at 10 or more consecutive days', () => {
    expect(needsRestDayWarning(10)).toBe(true);
    expect(needsRestDayWarning(11)).toBe(true);
  });
});
