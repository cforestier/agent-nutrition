import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { parseUpdate, sendMessage } from '../../lib/telegram.js';
import { converseWithTool } from '../../lib/claude.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';
import { isOnboardingBasicsComplete } from '../../lib/profile.js';
import { ONBOARDING_SYSTEM_PROMPT, ONBOARDING_TOOL, handleOnboardingTool } from '../../lib/onboarding.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { SCENARIO_TOOLS, handleScenarioTool, buildScenarioSystemPrompt } from '../../lib/scenarios.js';
import { SET_WEEKLY_SCHEDULE_TOOL, handleWeeklyScheduleTool } from '../../lib/weeklySchedule.js';
import { weeklyScheduleSystemPromptAddition } from '../../lib/weeklyScheduleStore.js';
import { LOG_WEIGHT_TOOL, handleLogWeightTool } from '../../lib/weight.js';
import { LOG_MEAL_TOOL, handleLogMealTool } from '../../lib/meals.js';
import { FLAG_CONCERN_TOOL, SAFETY_GUARDRAILS_PROMPT, handleFlagConcernTool } from '../../lib/safety.js';

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

const GENERAL_CHAT_TOOLS = [
  ...SCENARIO_TOOLS,
  SET_WEEKLY_SCHEDULE_TOOL,
  LOG_WEIGHT_TOOL,
  LOG_MEAL_TOOL,
  FLAG_CONCERN_TOOL,
];

async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}

async function handleOnboardingChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleOnboardingTool(input);
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(10);
  const onboardingDone = await isOnboardingBasicsComplete();

  const result = onboardingDone
    ? await converseWithTool(
        (await buildScenarioSystemPrompt(SYSTEM_PROMPT, todayIsoDate())) +
          (await weeklyScheduleSystemPromptAddition()) +
          SAFETY_GUARDRAILS_PROMPT,
        history,
        text,
        GENERAL_CHAT_TOOLS,
        handleGeneralChatTool
      )
    : await converseWithTool(
        ONBOARDING_SYSTEM_PROMPT + SAFETY_GUARDRAILS_PROMPT,
        history,
        text,
        [ONBOARDING_TOOL, FLAG_CONCERN_TOOL],
        handleOnboardingChatTool
      );

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
