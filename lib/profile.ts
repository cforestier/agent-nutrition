import { prisma } from './db.js';

export interface OnboardingProfileInput {
  startDate: string;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
  targetWeightKg: number;
  constraints: string[];
  weighInDay: string;
  reviewDay: string;
  restDayPresent: boolean;
}

export interface AcceptedOnboardingDecision {
  refused: false;
  ratePctPerWeek: number;
  weeks: number;
}

export async function saveOnboardingProfile(
  input: OnboardingProfileInput,
  decision: AcceptedOnboardingDecision
): Promise<void> {
  const data = {
    startDate: new Date(input.startDate),
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    age: input.age,
    sex: input.sex,
    targetWeightKg: input.targetWeightKg,
    targetWeeks: decision.weeks,
    ratePctPerWeek: decision.ratePctPerWeek,
    constraints: input.constraints,
    weighInDay: input.weighInDay,
    reviewDay: input.reviewDay,
    restDayPresent: input.restDayPresent,
    onboardingBasicsComplete: true,
  };

  const existing = await prisma.profile.findFirst();
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}

export async function isOnboardingBasicsComplete(): Promise<boolean> {
  const profile = await prisma.profile.findFirst();
  return profile?.onboardingBasicsComplete ?? false;
}

export async function flagEdSignal(reason: string): Promise<void> {
  const existing = await prisma.profile.findFirst();
  const data = { edSignalFlagged: true, edSignalNote: reason };
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}

export async function isEdSignalFlagged(): Promise<boolean> {
  const profile = await prisma.profile.findFirst();
  return profile?.edSignalFlagged ?? false;
}

export interface ProfileSnapshot {
  weightKg: number | null;
  ratePctPerWeek: number | null;
  currentTargetKcal: number | null;
  leanMassKg: number | null;
  kcalFloor: number | null;
  baselineStartedAt: string | null;
  lastAdjustmentDate: string | null;
  consecutiveDeficitWeeks: number;
}

export async function getProfileSnapshot(): Promise<ProfileSnapshot> {
  const profile = await prisma.profile.findFirst();
  return {
    weightKg: profile?.weightKg ?? null,
    ratePctPerWeek: profile?.ratePctPerWeek ?? null,
    currentTargetKcal: profile?.currentTargetKcal ?? null,
    leanMassKg: profile?.leanMassKg ?? null,
    kcalFloor: profile?.kcalFloor ?? null,
    baselineStartedAt: profile?.baselineStartedAt ?? null,
    lastAdjustmentDate: profile?.lastAdjustmentDate ?? null,
    consecutiveDeficitWeeks: profile?.consecutiveDeficitWeeks ?? 0,
  };
}

export interface BodyScanProfileUpdate {
  leanMassKg: number;
  kcalFloor: number;
  currentTargetKcal?: number;
}

export async function applyBodyScanToProfile(update: BodyScanProfileUpdate): Promise<void> {
  const data: { leanMassKg: number; kcalFloor: number; currentTargetKcal?: number } = {
    leanMassKg: update.leanMassKg,
    kcalFloor: update.kcalFloor,
  };
  if (update.currentTargetKcal !== undefined) {
    data.currentTargetKcal = update.currentTargetKcal;
  }

  const existing = await prisma.profile.findFirst();
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}

export interface RecomputeProfileUpdate {
  currentTargetKcal: number;
  lastAdjustmentDate: string;
  consecutiveDeficitWeeks: number;
}

export async function applyRecomputeToProfile(update: RecomputeProfileUpdate): Promise<void> {
  const existing = await prisma.profile.findFirst();
  if (!existing) return;
  await prisma.profile.update({ where: { id: existing.id }, data: update });
}

export async function setBaselineStartedAt(today: string): Promise<void> {
  const existing = await prisma.profile.findFirst();
  const data = { baselineStartedAt: today };
  if (existing) {
    await prisma.profile.update({ where: { id: existing.id }, data });
  } else {
    await prisma.profile.create({ data });
  }
}
