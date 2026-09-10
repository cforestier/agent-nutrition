import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 1024;

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
    system: systemPrompt,
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { text: 'Désolé, je ne peux pas répondre à ça.', outputTokens: response.usage.output_tokens };
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  return { text, outputTokens: response.usage.output_tokens };
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
      system: systemPrompt,
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
      return { text, outputTokens: totalOutputTokens };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { text: '', outputTokens: totalOutputTokens };
    }

    const resultContent = await handleTool(toolUseBlock.name, toolUseBlock.input as Record<string, unknown>);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: resultContent }],
    });
  }

  return { text: "Désolé, je n'ai pas réussi à traiter ta demande, réessaie.", outputTokens: totalOutputTokens };
}
