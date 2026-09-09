import { describe, it, expect } from 'vitest';
import { searchFood } from '../lib/foods.js';

describe('searchFood', () => {
  it('finds a real Ciqual food by a partial, accent-insensitive query', async () => {
    const result = await searchFood('riz basmati');

    expect(result).not.toBeNull();
    expect(result?.name.toLowerCase()).toContain('riz basmati');
    expect(result?.kcalPer100g).toBeGreaterThan(0);
  });

  it('returns null when nothing matches', async () => {
    const result = await searchFood('xyzzy-not-a-real-food-12345');
    expect(result).toBeNull();
  });
});
