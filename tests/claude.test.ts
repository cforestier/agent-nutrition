import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { converse } = await import('../lib/claude.js');

describe('converse', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('sends the system prompt and messages to the model and returns text + token count', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Bonjour !' }],
      usage: { output_tokens: 5 },
    });

    const result = await converse('system prompt', [{ role: 'user', content: 'salut' }]);

    expect(result).toEqual({ text: 'Bonjour !', outputTokens: 5 });
    expect(createMock).toHaveBeenCalledWith({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'salut' }],
    });
  });

  it('returns a fallback message when the model refuses', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'refusal',
      content: [],
      usage: { output_tokens: 0 },
    });

    const result = await converse('system prompt', [{ role: 'user', content: 'salut' }]);

    expect(result.text).toBe('Désolé, je ne peux pas répondre à ça.');
  });
});
