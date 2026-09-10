import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as telegram from '../lib/telegram.js';
import * as claudeLib from '../lib/claude.js';
import * as messagesLib from '../lib/messages.js';
import * as profileLib from '../lib/profile.js';
import * as onboardingLib from '../lib/onboarding.js';
import * as scenariosLib from '../lib/scenarios.js';
import * as weeklyScheduleStoreLib from '../lib/weeklyScheduleStore.js';
import { SET_WEEKLY_SCHEDULE_TOOL } from '../lib/weeklySchedule.js';
import { LOG_WEIGHT_TOOL } from '../lib/weight.js';
import { LOG_MEAL_TOOL, LOG_WEIGHED_MEAL_TOOL } from '../lib/meals.js';
import { SET_BODY_SCAN_TOOL, BODY_SCAN_PDF_PROMPT } from '../lib/bodyScan.js';
import { TRIGGER_REBASELINE_TOOL } from '../lib/rebaseline.js';
import { FLAG_CONCERN_TOOL, SAFETY_GUARDRAILS_PROMPT } from '../lib/safety.js';
import * as sleepLib from '../lib/sleep.js';

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
    vi.spyOn(weeklyScheduleStoreLib, 'weeklyScheduleSystemPromptAddition').mockResolvedValue('');
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
      'full system prompt' + SAFETY_GUARDRAILS_PROMPT,
      [],
      'salut',
      [
        ...scenariosLib.SCENARIO_TOOLS,
        SET_WEEKLY_SCHEDULE_TOOL,
        LOG_WEIGHT_TOOL,
        LOG_MEAL_TOOL,
        LOG_WEIGHED_MEAL_TOOL,
        SET_BODY_SCAN_TOOL,
        TRIGGER_REBASELINE_TOOL,
        FLAG_CONCERN_TOOL,
      ],
      expect.any(Function)
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
      onboardingLib.ONBOARDING_SYSTEM_PROMPT + SAFETY_GUARDRAILS_PROMPT,
      [],
      '80kg',
      [onboardingLib.ONBOARDING_TOOL, FLAG_CONCERN_TOOL],
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

  it('downloads a PDF document, sends it to Claude with the body-scan prompt, and replies with the extraction', async () => {
    vi.spyOn(scenariosLib, 'buildScenarioSystemPrompt').mockResolvedValue('full system prompt');
    vi.spyOn(weeklyScheduleStoreLib, 'weeklyScheduleSystemPromptAddition').mockResolvedValue('');
    vi.spyOn(messagesLib, 'recentMessages').mockResolvedValue([]);
    const downloadSpy = vi.spyOn(telegram, 'downloadTelegramFile').mockResolvedValue(Buffer.from('pdf-bytes'));
    const converseWithToolSpy = vi
      .spyOn(claudeLib, 'converseWithTool')
      .mockResolvedValue({ text: 'Masse maigre 58.63 kg, poids 76 kg. Tu confirmes ?', outputTokens: 10 });
    const saveSpy = vi.spyOn(messagesLib, 'saveMessage').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = {
      message: { chat: { id: 12345 }, document: { file_id: 'file123', mime_type: 'application/pdf' } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(downloadSpy).toHaveBeenCalledWith('file123');
    expect(converseWithToolSpy).toHaveBeenCalledWith(
      'full system prompt' + SAFETY_GUARDRAILS_PROMPT + BODY_SCAN_PDF_PROMPT,
      [],
      expect.any(String),
      [
        ...scenariosLib.SCENARIO_TOOLS,
        SET_WEEKLY_SCHEDULE_TOOL,
        LOG_WEIGHT_TOOL,
        LOG_MEAL_TOOL,
        LOG_WEIGHED_MEAL_TOOL,
        SET_BODY_SCAN_TOOL,
        TRIGGER_REBASELINE_TOOL,
        FLAG_CONCERN_TOOL,
      ],
      expect.any(Function),
      Buffer.from('pdf-bytes').toString('base64')
    );
    expect(saveSpy).toHaveBeenCalledWith('assistant', 'Masse maigre 58.63 kg, poids 76 kg. Tu confirmes ?', 10);
    expect(sendSpy).toHaveBeenCalledWith(12345, 'Masse maigre 58.63 kg, poids 76 kg. Tu confirmes ?');
  });

  it('replies with a short message and does not call the model for a non-PDF document', async () => {
    const downloadSpy = vi.spyOn(telegram, 'downloadTelegramFile').mockResolvedValue(Buffer.from(''));
    const converseWithToolSpy = vi.spyOn(claudeLib, 'converseWithTool');
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = {
      message: { chat: { id: 12345 }, document: { file_id: 'file123', mime_type: 'image/jpeg' } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(converseWithToolSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('PDF'));
  });

  it('answers the callback query and saves the sleep quality when a sleep button is tapped', async () => {
    const answerSpy = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue();
    const saveSpy = vi.spyOn(sleepLib, 'saveSleepQuality').mockResolvedValue();
    const sendSpy = vi.spyOn(telegram, 'sendMessage').mockResolvedValue();
    const res = mockRes();
    const body = {
      callback_query: { id: 'cq1', data: 'sleep:medium', message: { chat: { id: 12345 } } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(answerSpy).toHaveBeenCalledWith('cq1');
    expect(saveSpy).toHaveBeenCalledWith(expect.any(String), 'medium');
    expect(sendSpy).toHaveBeenCalledWith(12345, expect.stringContaining('medium'));
  });

  it('ignores a callback query from another chat', async () => {
    const answerSpy = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue();
    const saveSpy = vi.spyOn(sleepLib, 'saveSleepQuality').mockResolvedValue();
    const res = mockRes();
    const body = {
      callback_query: { id: 'cq1', data: 'sleep:medium', message: { chat: { id: 999 } } },
    };

    await handler({ method: 'POST', body } as any, res as any);
    await flushBackgroundTasks();

    expect(res.statusCode).toBe(200);
    expect(answerSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
