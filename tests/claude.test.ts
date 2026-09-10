import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from '../lib/claude.js';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { converse, converseWithTool } = await import('../lib/claude.js');

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

describe('converseWithTool', () => {
  const tool: ToolDefinition = {
    name: 'test_tool',
    description: 'A test tool',
    input_schema: { type: 'object', properties: {} },
  };

  beforeEach(() => {
    createMock.mockReset();
  });

  it('executes the tool once and returns the final text response', async () => {
    createMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'test_tool', input: { foo: 'bar' } }],
        usage: { output_tokens: 3 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Terminé.' }],
        usage: { output_tokens: 4 },
      });

    const handleTool = vi.fn().mockResolvedValue('tool result text');

    const result = await converseWithTool('system', [], 'salut', [tool], handleTool);

    expect(handleTool).toHaveBeenCalledWith('test_tool', { foo: 'bar' });
    expect(result).toEqual({ text: 'Terminé.', outputTokens: 7 });
  });

  it('returns the model text directly when no tool is called', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Quel est ton poids actuel ?' }],
      usage: { output_tokens: 6 },
    });

    const handleTool = vi.fn();
    const result = await converseWithTool('system', [], 'je veux commencer', [tool], handleTool);

    expect(handleTool).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'Quel est ton poids actuel ?', outputTokens: 6 });
  });

  it('dispatches to the correct tool by name when multiple tools are offered', async () => {
    createMock
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_2', name: 'second_tool', input: { x: 1 } }],
        usage: { output_tokens: 2 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { output_tokens: 1 },
      });

    const secondTool: ToolDefinition = {
      name: 'second_tool',
      description: '',
      input_schema: { type: 'object', properties: {} },
    };
    const handleTool = vi.fn().mockResolvedValue('handled');

    await converseWithTool('system', [], 'salut', [tool, secondTool], handleTool);

    expect(handleTool).toHaveBeenCalledWith('second_tool', { x: 1 });
  });

  it('attaches a base64 PDF as a document content block on the user message when documentBase64 is given', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Voici ce que je lis dans ton scan.' }],
      usage: { output_tokens: 5 },
    });

    const handleTool = vi.fn();
    await converseWithTool('system', [], 'voici mon scan', [tool], handleTool, 'BASE64DATA');

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BASE64DATA' } },
              { type: 'text', text: 'voici mon scan' },
            ],
          },
        ],
      })
    );
  });

  it('stops after the iteration cap if the model keeps calling tools', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool_x', name: 'test_tool', input: {} }],
      usage: { output_tokens: 1 },
    });
    const handleTool = vi.fn().mockResolvedValue('ok');

    const result = await converseWithTool('system', [], 'salut', [tool], handleTool);

    expect(result.text).toBe("Désolé, je n'ai pas réussi à traiter ta demande, réessaie.");
  });
});
