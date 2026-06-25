import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/providers/AnthropicProvider';
import { OllamaProvider } from '../src/providers/OllamaProvider';
import { OpenAICompatProvider } from '../src/providers/OpenAICompatProvider';
import { AdapterStreamEvent, Message } from '../src/providers/ProviderAdapter';
import { ToolDefinition } from '../src/schema/ToolTypes';

const config = { provider: 'x', model: 'test-model' };
const tools: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
];

const toolMessages: Message[] = [
  { role: 'user', content: 'Read a.txt' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } }] },
  { role: 'tool', content: 'file body', toolCallId: 'call_0', name: 'read_file' },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', { status: 200 });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sentBody(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fn.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

async function collectEvents(gen: AsyncGenerator<AdapterStreamEvent>): Promise<AdapterStreamEvent[]> {
  const events: AdapterStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAICompatProvider wire format', () => {
  it('sends tools, tool_choice, and serialized tool history', async () => {
    const fn = mockFetch(jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    const provider = new OpenAICompatProvider('https://api.test');
    await provider.complete(toolMessages, config, undefined, { tools, toolChoice: 'auto' });

    const body = sentBody(fn);
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters: tools[0].parameters },
    }]);
    expect(body.tool_choice).toBe('auto');
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'file body' });
  });

  it('parses non-streaming tool calls with JSON-string arguments', async () => {
    mockFetch(jsonResponse({
      choices: [{
        message: { content: null, tool_calls: [{ id: 'abc', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }));
    const provider = new OpenAICompatProvider('https://api.test');
    const result = await provider.complete([{ role: 'user', content: 'go' }], config, undefined, { tools });

    expect(result.toolCalls).toEqual([{ id: 'abc', name: 'read_file', arguments: { path: 'a.txt' } }]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.inputTokens).toBe(9);
  });

  it('accumulates fragmented streaming tool-call deltas', async () => {
    mockFetch(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"abc","function":{"name":"read_file","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]));
    const provider = new OpenAICompatProvider('https://api.test');
    const events = await collectEvents(provider.streamEvents([{ role: 'user', content: 'go' }], config, undefined, { tools }));

    const end = events.find(e => e.type === 'tool_call_end') as Extract<AdapterStreamEvent, { type: 'tool_call_end' }>;
    expect(end.toolCall).toEqual({ id: 'abc', name: 'read_file', arguments: { path: 'a.txt' } });
    const finish = events.find(e => e.type === 'finish') as Extract<AdapterStreamEvent, { type: 'finish' }>;
    expect(finish.finishReason).toBe('tool_calls');
  });

  it('passes multimodal content blocks through unchanged', async () => {
    const fn = mockFetch(jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    const provider = new OpenAICompatProvider('https://api.test');
    const blocks = [
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text' as const, text: 'describe' },
    ];
    await provider.complete([{ role: 'user', content: blocks }], config);
    const messages = sentBody(fn).messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual(blocks);
  });
});

describe('AnthropicProvider wire format', () => {
  it('sends tools with input_schema and merges tool results into a user message', async () => {
    const fn = mockFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    const provider = new AnthropicProvider('key');
    await provider.complete(toolMessages, config, undefined, { tools, toolChoice: 'required' });

    const body = sentBody(fn);
    expect(body.tools).toEqual([{ name: 'read_file', description: 'Read a file', input_schema: tools[0].parameters }]);
    expect(body.tool_choice).toEqual({ type: 'any' });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_0', name: 'read_file', input: { path: 'a.txt' } }],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'file body' }],
    });
  });

  it('parses tool_use blocks and maps stop_reason tool_use', async () => {
    mockFetch(jsonResponse({
      content: [
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    const provider = new AnthropicProvider('key');
    const result = await provider.complete([{ role: 'user', content: 'go' }], config, undefined, { tools });

    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'read_file', arguments: { path: 'a.txt' } }]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('Checking. ');
  });

  it('streams tool calls via content_block events', async () => {
    mockFetch(sseResponse([
      'event: message_start',
      'data: {"message":{"usage":{"input_tokens":5}}}',
      'event: content_block_start',
      'data: {"index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"read_file"}}',
      'event: content_block_delta',
      'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}',
      'event: content_block_stop',
      'data: {"index":0}',
      'event: message_delta',
      'data: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
    ]));
    const provider = new AnthropicProvider('key');
    const events = await collectEvents(provider.streamEvents([{ role: 'user', content: 'go' }], config, undefined, { tools }));

    const end = events.find(e => e.type === 'tool_call_end') as Extract<AdapterStreamEvent, { type: 'tool_call_end' }>;
    expect(end.toolCall).toEqual({ id: 'tu_1', name: 'read_file', arguments: { path: 'a.txt' } });
    const usage = events.find(e => e.type === 'usage') as Extract<AdapterStreamEvent, { type: 'usage' }>;
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    const finish = events.find(e => e.type === 'finish') as Extract<AdapterStreamEvent, { type: 'finish' }>;
    expect(finish.finishReason).toBe('tool_calls');
  });

  it('converts data-URL image blocks to base64 sources', async () => {
    const fn = mockFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    const provider = new AnthropicProvider('key');
    await provider.complete([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'text', text: 'describe' },
      ],
    }], config);
    const messages = sentBody(fn).messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'describe' },
    ]);
  });
});

describe('OllamaProvider wire format', () => {
  it('sends tools and tool history with tool_name', async () => {
    const fn = mockFetch(jsonResponse({ message: { content: 'ok' }, done: true, done_reason: 'stop' }));
    const provider = new OllamaProvider('http://localhost:11434');
    await provider.complete(toolMessages, config, undefined, { tools });

    const body = sentBody(fn);
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters: tools[0].parameters },
    }]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
    });
    expect(messages[2]).toEqual({ role: 'tool', content: 'file body', tool_name: 'read_file' });
  });

  it('synthesizes call ids for parsed tool calls', async () => {
    mockFetch(jsonResponse({
      message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      done: true,
      prompt_eval_count: 8,
      eval_count: 2,
    }));
    const provider = new OllamaProvider();
    const result = await provider.complete([{ role: 'user', content: 'go' }], config, undefined, { tools });

    expect(result.toolCalls).toEqual([{ id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } }]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.inputTokens).toBe(8);
  });

  it('emits start/end pairs for whole-chunk streaming tool calls and usage at done', async () => {
    mockFetch(new Response([
      JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] } }),
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 2 }),
    ].join('\n') + '\n', { status: 200 }));
    const provider = new OllamaProvider();
    const events = await collectEvents(provider.streamEvents([{ role: 'user', content: 'go' }], config, undefined, { tools }));

    const types = events.map(e => e.type);
    expect(types).toEqual(['tool_call_start', 'tool_call_end', 'usage', 'finish']);
    const finish = events[events.length - 1] as Extract<AdapterStreamEvent, { type: 'finish' }>;
    expect(finish.finishReason).toBe('tool_calls');
  });

  it('converts image blocks to a base64 images array and rejects URLs', async () => {
    const fn = mockFetch(jsonResponse({ message: { content: 'ok' }, done: true }));
    const provider = new OllamaProvider();
    await provider.complete([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'text', text: 'describe' },
      ],
    }], config);
    const messages = sentBody(fn).messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'user', content: 'describe', images: ['AAA'] });

    await expect(provider.complete([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }],
    }], config)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps caller aborts to REQUEST_ABORTED', async () => {
    const caller = new AbortController();
    const fn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    vi.stubGlobal('fetch', fn);
    const provider = new OllamaProvider();
    const pending = provider.complete([{ role: 'user', content: 'go' }], config, undefined, { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });
});

describe('cached input tokens (prompt-cache visibility)', () => {
  it('OpenAI-compat complete parses prompt_tokens_details.cached_tokens', async () => {
    mockFetch(jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1024 } },
    }));
    const result = await new OpenAICompatProvider('https://api.test').complete([{ role: 'user', content: 'go' }], config);
    expect(result.inputTokens).toBe(1200);
    expect(result.cachedInputTokens).toBe(1024);
  });

  it('OpenAI-compat complete leaves cachedInputTokens undefined when the provider omits it', async () => {
    mockFetch(jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }));
    const result = await new OpenAICompatProvider('https://api.test').complete([{ role: 'user', content: 'go' }], config);
    expect(result.cachedInputTokens).toBeUndefined();
  });

  it('OpenAI-compat stream emits cachedInputTokens on the usage event', async () => {
    mockFetch(sseResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":1024}}}',
      'data: [DONE]',
    ]));
    const events = await collectEvents(new OpenAICompatProvider('https://api.test').streamEvents([{ role: 'user', content: 'go' }], config));
    const usage = events.find(e => e.type === 'usage') as Extract<AdapterStreamEvent, { type: 'usage' }>;
    expect(usage).toMatchObject({ inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024 });
  });

  it('Anthropic complete parses cache_read_input_tokens', async () => {
    mockFetch(jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1024 },
    }));
    const result = await new AnthropicProvider('key').complete([{ role: 'user', content: 'go' }], config);
    expect(result.cachedInputTokens).toBe(1024);
  });

  it('Anthropic stream emits cachedInputTokens from message_start', async () => {
    mockFetch(sseResponse([
      'event: message_start',
      'data: {"message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":1024}}}',
      'event: content_block_delta',
      'data: {"index":0,"delta":{"type":"text_delta","text":"hi"}}',
      'event: message_delta',
      'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}',
    ]));
    const events = await collectEvents(new AnthropicProvider('key').streamEvents([{ role: 'user', content: 'go' }], config));
    const usage = events.find(e => e.type === 'usage') as Extract<AdapterStreamEvent, { type: 'usage' }>;
    expect(usage).toMatchObject({ inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024 });
  });
});
