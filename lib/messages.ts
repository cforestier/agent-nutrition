import { prisma } from './db.js';
import type { ChatMessage } from './claude.js';

export async function saveMessage(
  role: 'user' | 'assistant',
  content: string,
  tokensUsed?: number
): Promise<void> {
  await prisma.message.create({ data: { role, content, tokensUsed } });
}

export async function recentMessages(limit = 10): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.reverse().map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content }));
}
