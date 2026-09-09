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
