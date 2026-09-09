import { isBelowBmiFloor } from './baseline.js';

export function clampToFloor(targetKcal: number, kcalFloor: number): number {
  return Math.max(targetKcal, kcalFloor);
}

export function shouldRefuseProgram(currentWeightKg: number, targetWeightKg: number, heightCm: number): boolean {
  return isBelowBmiFloor(currentWeightKg, heightCm) || isBelowBmiFloor(targetWeightKg, heightCm);
}

export function isRapidLossAlert(weightStartKg: number, weightEndKg: number): boolean {
  const changePct = ((weightStartKg - weightEndKg) / weightStartKg) * 100;
  return changePct > 1;
}

export interface RedsSignals {
  highVolume: boolean;
  inDeficit: boolean;
  performanceDeclining: boolean;
  highFatigue: boolean;
}

export function isRedsAlert(signals: RedsSignals): boolean {
  return signals.highVolume && signals.inDeficit && signals.performanceDeclining && signals.highFatigue;
}

export function needsRestDayWarning(consecutiveDaysWithoutRest: number): boolean {
  return consecutiveDaysWithoutRest >= 10;
}
