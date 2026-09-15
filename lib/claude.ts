import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const MODEL = 'claude-sonnet-5';
// Sonnet 5 has adaptive thinking on by default, drawing from this same max_tokens budget rather
// than a separate allowance — a long user message (e.g. several activities in one recap) can burn
// the whole budget on the thinking block alone, leaving stop_reason 'max_tokens' with no text or
// tool_use at all. 1024 was too tight a ceiling for that; this is headroom against it.
const MAX_TOKENS = 8192;

// Telegram's sendMessage rejects an empty body (400 "message text is empty"), which can happen
// when a response is truncated before any text block starts (e.g. stop_reason 'max_tokens') —
// every return path below must fall back to this instead of ''.
const FALLBACK_TEXT = "Désolé, je n'ai pas de réponse à te donner, réessaie.";

// Logged only on the empty-text path, so it stays silent on every normal turn and shows up in
// Vercel logs exactly when FALLBACK_TEXT is about to be used — the evidence needed to tell a
// max_tokens truncation apart from the other empty-content edge cases.
function logEmptyTextResponse(context: string, response: Anthropic.Message): void {
  console.error('Empty-text Claude response', {
    context,
    stopReason: response.stop_reason,
    contentBlocks: response.content.map((block) => ({
      type: block.type,
      ...(block.type === 'text' ? { textLength: block.text.length } : {}),
      ...(block.type === 'tool_use' ? { toolName: block.name } : {}),
    })),
    outputTokens: response.usage.output_tokens,
  });
}

function cachedSystemPrompt(systemPrompt: string): Anthropic.MessageCreateParams['system'] {
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConverseResult {
  text: string;
  outputTokens: number;
}

export async function converse(systemPrompt: string, messages: ChatMessage[]): Promise<ConverseResult> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: cachedSystemPrompt(systemPrompt),
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { text: 'Désolé, je ne peux pas répondre à ça.', outputTokens: response.usage.output_tokens };
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  if (!text) logEmptyTextResponse('converse', response);
  return { text: text || FALLBACK_TEXT, outputTokens: response.usage.output_tokens };
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (toolName: string, input: Record<string, unknown>) => Promise<string>;

const MAX_TOOL_ITERATIONS = 4;

export async function converseWithTool(
  systemPrompt: string,
  history: ChatMessage[],
  userText: string,
  tools: ToolDefinition[],
  handleTool: ToolHandler,
  documentBase64?: string
): Promise<ConverseResult> {
  const userContent: Anthropic.MessageParam['content'] = documentBase64
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: documentBase64 } },
        { type: 'text', text: userText },
      ]
    : userText;

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  let totalOutputTokens = 0;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: cachedSystemPrompt(systemPrompt),
      tools,
      messages,
    });
    totalOutputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'refusal') {
      return { text: 'Désolé, je ne peux pas répondre à ça.', outputTokens: totalOutputTokens };
    }

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((block) => block.type === 'text');
      const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      if (!text) logEmptyTextResponse('converseWithTool:final', response);
      return { text: text || FALLBACK_TEXT, outputTokens: totalOutputTokens };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    if (toolUseBlocks.length === 0) {
      logEmptyTextResponse('converseWithTool:missing-tool-use', response);
      return { text: FALLBACK_TEXT, outputTokens: totalOutputTokens };
    }

    // Claude can emit several tool_use blocks in one turn (e.g. several activities logged at
    // once) — every one of them needs a matching tool_result, or the next messages.create call
    // is rejected outright by the API.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUseBlock of toolUseBlocks) {
      const resultContent = await handleTool(toolUseBlock.name, toolUseBlock.input as Record<string, unknown>);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUseBlock.id, content: resultContent });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { text: "Désolé, je n'ai pas réussi à traiter ta demande, réessaie.", outputTokens: totalOutputTokens };
}
