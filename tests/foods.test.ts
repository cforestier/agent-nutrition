import { describe, it, expect } from 'vitest';
import { searchFoodCandidates } from '../lib/foods.js';

describe('searchFoodCandidates', () => {
  it('finds real Ciqual foods by a partial, accent-insensitive query', async () => {
    const results = await searchFoodCandidates('riz basmati');

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((f) => f.name.toLowerCase().includes('riz basmati'))).toBe(true);
    expect(results[0].kcalPer100g).toBeGreaterThan(0);
  });

  it('returns an empty array when nothing matches', async () => {
    const results = await searchFoodCandidates('xyzzy-not-a-real-food-12345');
    expect(results).toEqual([]);
  });

  it('caps the number of candidates returned', async () => {
    const results = await searchFoodCandidates('poulet', 3);
    expect(results.length).toBe(3);
  });
});
