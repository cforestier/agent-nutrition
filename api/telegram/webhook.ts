import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';
import { converseWithTool } from '../../lib/claude.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';
import { isOnboardingBasicsComplete } from '../../lib/profile.js';
import { ONBOARDING_SYSTEM_PROMPT, ONBOARDING_TOOL, handleOnboardingTool } from '../../lib/onboarding.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { SCENARIO_TOOLS, handleScenarioTool, buildScenarioSystemPrompt } from '../../lib/scenarios.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);
  const parsed = parseUpdate(req.body, allowedChatId);

  res.status(200).json({ ok: true });

  if (!parsed) return;

  waitUntil(handleMessage(parsed.chatId, parsed.text));
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(10);
  const onboardingDone = await isOnboardingBasicsComplete();

  const result = onboardingDone
    ? await converseWithTool(
        await buildScenarioSystemPrompt(SYSTEM_PROMPT, todayIsoDate()),
        history,
        text,
        SCENARIO_TOOLS,
        handleScenarioTool
      )
    : await converseWithTool(
        ONBOARDING_SYSTEM_PROMPT,
        history,
        text,
        [ONBOARDING_TOOL],
        (_name, input) => handleOnboardingTool(input)
      );

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
