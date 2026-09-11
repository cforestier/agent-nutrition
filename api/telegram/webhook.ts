import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import {
  parseUpdate,
  sendMessage,
  parseCallbackQuery,
  answerCallbackQuery,
  downloadTelegramFile,
} from '../../lib/telegram.js';
import { saveSleepQuality } from '../../lib/sleep.js';
import type { SleepQuality } from '../../lib/calc/baseline.js';
import { converseWithTool } from '../../lib/claude.js';
import { recentMessages, saveMessage } from '../../lib/messages.js';
import { isOnboardingBasicsComplete } from '../../lib/profile.js';
import { ONBOARDING_SYSTEM_PROMPT, ONBOARDING_TOOL, handleOnboardingTool } from '../../lib/onboarding.js';
import { SYSTEM_PROMPT } from '../../lib/prompts.js';
import { SCENARIO_TOOLS, handleScenarioTool, buildScenarioSystemPrompt } from '../../lib/scenarios.js';
import { SET_WEEKLY_SCHEDULE_TOOL, handleWeeklyScheduleTool } from '../../lib/weeklySchedule.js';
import { weeklyScheduleSystemPromptAddition } from '../../lib/weeklyScheduleStore.js';
import { LOG_WEIGHT_TOOL, handleLogWeightTool } from '../../lib/weight.js';
import { LOG_MEAL_TOOL, LOG_WEIGHED_MEAL_TOOL, handleLogMealTool, handleLogWeighedMealTool } from '../../lib/meals.js';
import { SET_BODY_SCAN_TOOL, handleSetBodyScanTool, BODY_SCAN_PDF_PROMPT } from '../../lib/bodyScan.js';
import { TRIGGER_REBASELINE_TOOL, handleTriggerRebaselineTool } from '../../lib/rebaseline.js';
import { LOG_ACTIVITY_TOOL, handleLogActivityTool } from '../../lib/activity.js';
import { FLAG_CONCERN_TOOL, SAFETY_GUARDRAILS_PROMPT, handleFlagConcernTool } from '../../lib/safety.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

  const callbackQuery = parseCallbackQuery(req.body, allowedChatId);
  if (callbackQuery) {
    res.status(200).json({ ok: true });
    waitUntil(handleCallbackQuery(callbackQuery));
    return;
  }

  const parsed = parseUpdate(req.body, allowedChatId);

  res.status(200).json({ ok: true });

  if (!parsed) return;

  if (parsed.kind === 'text') {
    waitUntil(handleMessage(parsed.chatId, parsed.text));
    return;
  }

  if (parsed.mimeType !== 'application/pdf') {
    waitUntil(sendMessage(parsed.chatId, "Je ne sais lire qu'un PDF pour l'instant."));
    return;
  }

  waitUntil(handlePdfMessage(parsed.chatId, parsed.fileId));
}

const HISTORY_MESSAGE_LIMIT = 40;

const GENERAL_CHAT_TOOLS = [
  ...SCENARIO_TOOLS,
  SET_WEEKLY_SCHEDULE_TOOL,
  LOG_WEIGHT_TOOL,
  LOG_MEAL_TOOL,
  LOG_WEIGHED_MEAL_TOOL,
  SET_BODY_SCAN_TOOL,
  TRIGGER_REBASELINE_TOOL,
  LOG_ACTIVITY_TOOL,
  FLAG_CONCERN_TOOL,
];

async function handleGeneralChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'set_weekly_schedule') return handleWeeklyScheduleTool(input);
  if (name === 'log_weight') return handleLogWeightTool(input);
  if (name === 'log_meal') return handleLogMealTool(input);
  if (name === 'log_weighed_meal') return handleLogWeighedMealTool(input);
  if (name === 'set_body_scan') return handleSetBodyScanTool(input);
  if (name === 'trigger_rebaseline') return handleTriggerRebaselineTool(input);
  if (name === 'log_activity') return handleLogActivityTool(input);
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleScenarioTool(name, input);
}

async function handleOnboardingChatTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'flag_concern') return handleFlagConcernTool(input);
  return handleOnboardingTool(input);
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const history = await recentMessages(HISTORY_MESSAGE_LIMIT);
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
        ONBOARDING_SYSTEM_PROMPT + `\n\nDate du jour : ${todayIsoDate()}.` + SAFETY_GUARDRAILS_PROMPT,
        history,
        text,
        [ONBOARDING_TOOL, FLAG_CONCERN_TOOL],
        handleOnboardingChatTool
      );

  await saveMessage('user', text);
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}

async function handlePdfMessage(chatId: number, fileId: string): Promise<void> {
  const history = await recentMessages(HISTORY_MESSAGE_LIMIT);
  const fileBuffer = await downloadTelegramFile(fileId);
  const documentBase64 = fileBuffer.toString('base64');

  const result = await converseWithTool(
    (await buildScenarioSystemPrompt(SYSTEM_PROMPT, todayIsoDate())) +
      (await weeklyScheduleSystemPromptAddition()) +
      SAFETY_GUARDRAILS_PROMPT +
      BODY_SCAN_PDF_PROMPT,
    history,
    'Voici mon scan de composition corporelle (PDF).',
    GENERAL_CHAT_TOOLS,
    handleGeneralChatTool,
    documentBase64
  );

  await saveMessage('user', '[PDF composition corporelle envoyé]');
  await saveMessage('assistant', result.text, result.outputTokens);
  await sendMessage(chatId, result.text);
}

const SLEEP_QUALITIES: SleepQuality[] = ['good', 'medium', 'bad'];

async function handleCallbackQuery(cq: { callbackQueryId: string; chatId: number; data: string }): Promise<void> {
  await answerCallbackQuery(cq.callbackQueryId);

  if (cq.data.startsWith('sleep:')) {
    const quality = cq.data.slice('sleep:'.length);
    if (SLEEP_QUALITIES.includes(quality as SleepQuality)) {
      await saveSleepQuality(todayIsoDate(), quality as SleepQuality);
      await sendMessage(cq.chatId, `Nuit notée : ${quality}.`);
    }
  }
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
