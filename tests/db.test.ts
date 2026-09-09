import { describe, it, expect } from 'vitest';
import { prisma } from '../lib/db.js';

describe('MongoDB connectivity', () => {
  it('can query the Profile collection through Prisma', async () => {
    const count = await prisma.profile.count();
    expect(typeof count).toBe('number');
  });
});
