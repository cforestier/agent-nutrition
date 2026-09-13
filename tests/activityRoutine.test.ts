import { describe, it, expect, vi, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { handleDefineActivityRoutineTool } from '../lib/activityRoutine.js';
import * as profileLib from '../lib/profile.js';

function baseProfile(weightKg: number | null) {
  return {
    weightKg,
    ratePctPerWeek: 0.5,
    currentTargetKcal: 2500,
    leanMassKg: 65,
    kcalFloor: 1950,
    baselineStartedAt: null,
    lastAdjustmentDate: null,
    consecutiveDeficitWeeks: 0,
    weighInDay: null as string | null,
    reviewDay: null as string | null,
  };
}

describe('handleDefineActivityRoutineTool', () => {
  afterAll(async () => {
    await prisma.activityRoutine.deleteMany({
      where: { name: { in: ['aller au bureau', 'routine kcal connu', 'incomplet', 'routine sans poids'] } },
    });
  });

  it('computes estimatedKcal and a blended discount from mixed-sport legs via the MET table', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(80));

    const result = await handleDefineActivityRoutineTool({
      name: 'aller au bureau',
      aliases: ['bureau', 'boulot'],
      legs: [
        { sportType: 'cycling', durationMinutes: 10, intensity: 'moderate' },
        { sportType: 'running', durationMinutes: 10, intensity: 'moderate' },
      ],
    });

    // cycling: 6.8*3.5*80/200*10 = 95.2 -> 95 ; running: 9.8*3.5*80/200*10 = 137.2 -> 137 ; total = 232
    // rabais pondéré = (95*0.2 + 137*0.25) / 232 ≈ 0.2295 -> "23%"
    expect(result).toContain('232');
    expect(result).toContain('23%');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'aller au bureau' } });
    expect(routine?.estimatedKcal).toBeCloseTo(232, 0);
    expect(routine?.blendedDiscountPct).toBeCloseTo(0.2295, 3);
    expect(routine?.sampleCount).toBe(0);
    expect(routine?.observedAvgKcal).toBeNull();
  });

  it('accepts a directly known kcal total with a primary sport type', async () => {
    const result = await handleDefineActivityRoutineTool({
      name: 'routine kcal connu',
      aliases: [],
      estimatedKcal: 500,
      primarySportType: 'running',
    });

    expect(result).toContain('500');
    expect(result).toContain('25%');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine kcal connu' } });
    expect(routine?.estimatedKcal).toBe(500);
    expect(routine?.blendedDiscountPct).toBeCloseTo(0.25, 5);
  });

  it('rejects a definition with neither legs nor a known kcal total', async () => {
    const result = await handleDefineActivityRoutineTool({ name: 'incomplet', aliases: [] });
    expect(result).toContain('manque');

    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'incomplet' } });
    expect(routine).toBeNull();
  });

  it('asks for the missing weight when legs are given without a known weight', async () => {
    vi.spyOn(profileLib, 'getProfileSnapshot').mockResolvedValue(baseProfile(null));

    const result = await handleDefineActivityRoutineTool({
      name: 'routine sans poids',
      aliases: [],
      legs: [{ sportType: 'cycling', durationMinutes: 10, intensity: 'moderate' }],
    });

    expect(result).toContain('poids');
    const routine = await prisma.activityRoutine.findFirst({ where: { name: 'routine sans poids' } });
    expect(routine).toBeNull();
  });
});
