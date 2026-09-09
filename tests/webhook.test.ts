import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as telegram from '../lib/telegram.js';
import * as claudeLib from '../lib/claude.js';
import * as messagesLib from '../lib/messages.js';
import * as profileLib from '../lib/profile.js';
import * as onboardingLib from '../lib/onboarding.js';
import * as scenariosLib from '../lib/scenarios.js';

const backgroundTasks: Promise<unknown>[] = [];

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    backgroundTasks.push(promise);
    return promise;
  },
}));

const handler = (await import('../api/telegram/webhook.js')).default;

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function flushBackgroundTasks() {
  await Promise.all(backgroundTasks);
  backgroundTasks.length = 0;
}

describe('POST /api/telegram/webhook', () => {
  beforeEach(() => {
    process.env.TELEGRAM_CHAT_ID = '12345';
    backgroundTasks.length = 0;
  });

  it('rejects non-POST requests', async () => {
    const res = mockRes();
    await handler({ method: 'GET', body: {} } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it("responds 200 and replies with Claude's answer from the allowed chat", async () => {
    vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(true);
    vi.spyOn(scenariosLib, 'buildScenarioSystemPrompt').mockResolvedValue('full system prompt');
    vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
    const converseWithToolSpy = vi
      .spyOn(claudeLib, 'converseWithTool')
      .mockResolvedValue({ text: 'Bonjour !', outputTokens: 5 });
    const saveSpy = vi.spyOn(messagesLib, 'saveMessage').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = { message: { chat: { id: 12345 }, text: 'salut' } };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(converseWithToolSpy).toHaveBeenCalledWith(
      'full system prompt',
      [],
      'salut',
      scenariosLib.SCENARIO_TOOLS,
      scenariosLib.handleScenarioTool
    );
    expect(saveSpy).toHaveBeenCalledWith('user', 'salut');
    expect(saveSpy).toHaveBeenCalledWith('assistant', 'Bonjour !', 5);
    expect(sendSpy).toHaveBeenCalledWith(12345, 'Bonjour !');
  });

  it('routes to the onboarding tool flow when onboarding basics are not yet saved', async () => {
    vi.spyOn(profileLib, 'isOnboardingBasicsComplete').mockResolvedValue(false);
    vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
    const converseWithToolSpy = vi
      .spyOn(claudeLib, 'converseWithTool')
      .mockResolvedValue({ text: 'Quel est ton poids ?', outputTokens: 4 });
    vi.spyOn(messagesLib, 'saveMessage').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = { message: { chat: { id: 12345 }, text: '80kg' } };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(converseWithToolSpy).toHaveBeenCalledWith(
      onboardingLib.ONBOARDING_SYSTEM_PROMPT,
      [],
      '80kg',
      [onboardingLib.ONBOARDING_TOOL],
      expect.any(Function)
    );
    expect(sendSpy).toHaveBeenCalledWith(12345, 'Quel est ton poids ?');
  });

  it('responds 200 but does nothing for a message from another chat', async () => {
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const converseWithToolSpy = vi.spyOn(claudeLib, 'converseWithTool');
    const res = mockRes();
    const body = { message: { chat: { id: 999 }, text: 'salut' } };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(converseWithToolSpy).not.toHaveBeenCalled();
  });
});
