import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveMessage, recentMessages } from '../lib/messages.js';

describe('messages', () => {
  const marker = `test-${Date.now()}`;

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { content: { contains: marker } } });
  });

  it('saves messages and returns them in chronological order', async () => {
    await saveMessage('user', `${marker}-hello`);
    await saveMessage('assistant', `${marker}-hi there`, 5);

    const recent = await recentMessages(2);

    expect(recent).toEqual([
      { role: 'user', content: `${marker}-hello` },
      { role: 'assistant', content: `${marker}-hi there` },
    ]);
  });
});
