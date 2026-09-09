import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveWeight, handleLogWeightTool } from '../lib/weight.js';

describe('weight logging', () => {
  const testDate = '1999-06-15';

  afterAll(async () => {
    await prisma.weight.deleteMany({ where: { date: testDate } });
  });

  it('creates a weight entry with source manual', async () => {
    await saveWeight({ date: testDate, weightKg: 80.5 });
    const saved = await prisma.weight.findUnique({ where: { date: testDate } });
    expect(saved?.weightKg).toBe(80.5);
    expect(saved?.source).toBe('manual');
  });

  it('overwrites the same date instead of duplicating on a second log', async () => {
    await saveWeight({ date: testDate, weightKg: 79.9 });
    const saved = await prisma.weight.findUnique({ where: { date: testDate } });
    expect(saved?.weightKg).toBe(79.9);
    const count = await prisma.weight.count({ where: { date: testDate } });
    expect(count).toBe(1);
  });

  it('handleLogWeightTool saves and returns a confirmation message', async () => {
    const result = await handleLogWeightTool({ date: testDate, weightKg: 78.2 });
    expect(result).toContain(testDate);
    expect(result).toContain('78.2');
    const saved = await prisma.weight.findUnique({ where: { date: testDate } });
    expect(saved?.weightKg).toBe(78.2);
  });
});
