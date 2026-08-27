import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesProvider } from '../src/providers/OpenAIResponsesProvider';
import { AdapterStreamEvent, Message } from '../src/providers/ProviderAdapter';
import { PriestConfig } from '../src/schema/PriestConfig';
import { ToolDefinition } from '../src/schema/ToolTypes';

const config: PriestConfig = { provider: 'responses', model: 'gpt-test' };
const tools: ToolDefinition[] = [{
  name: 'lookup',
  description: 'Look up a record.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
}];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

function chunkedSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\r\n\r\n`;
}

async function collectEvents(
  generator: AsyncGenerator<AdapterStreamEvent>,
): Promise<AdapterStreamEvent[]> {
  const events: AdapterStreamEvent[] = [];
  for await (const item of generator) events.push(item);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAIResponsesProvider complete wire format', () => {
  it('sends text, image, JSON Schema, tools, reasoning, and protected operation fields', async () => {
    const dispatcher = { dispatch: vi.fn() };
    const fn = mockFetch(jsonResponse({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"label":"cat"}' }] }],
    }));
    const provider = new OpenAIResponsesProvider('https://base.test/', 'secret', {
      url: 'https://responses.test/custom',
      headers: { 'X-Test': 'yes' },
      dispatcher,
    });

    await provider.complete([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'text', text: 'Classify.' },
      ],
    }], {
      ...config,
      maxOutputTokens: 200,
      reasoning: { enabled: true, effort: 'medium', summary: 'auto' },
      providerOptions: {
        store: true,
        temperature: 0.2,
        model: 'must-not-win',
        input: 'must-not-win',
        stream: true,
      },
    }, {
      jsonSchema: {
        type: 'object',
        properties: { label: { type: 'string' } },
        required: ['label'],
        additionalProperties: false,
      },
      jsonSchemaName: 'classification',
      jsonSchemaStrict: true,
    }, { tools, toolChoice: { name: 'lookup' } });

    expect(fn.mock.calls[0][0]).toBe('https://responses.test/custom');
    const init = fn.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'X-Test': 'yes',
    });
    expect(init.dispatcher).toBe(dispatcher);

    const body = sentBody(fn);
    expect(body).toMatchObject({
      model: 'gpt-test',
      stream: false,
      store: true,
      temperature: 0.2,
      max_output_tokens: 200,
      reasoning: { effort: 'medium', summary: 'auto' },
      tool_choice: { type: 'function', name: 'lookup' },
    });
    expect(body.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        { type: 'input_text', text: 'Classify.' },
      ],
    }]);
    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'classification',
        schema: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'lookup',
      description: 'Look up a record.',
      parameters: tools[0].parameters,
    }]);
  });

  it('maps provider JSON mode to Responses text.format', async () => {
    const fn = mockFetch(jsonResponse({ status: 'completed', output: [] }));
    await new OpenAIResponsesProvider('https://api.test').complete(
      [{ role: 'user', content: 'Return JSON.' }],
      config,
      { providerFormat: 'json' },
    );
    expect(sentBody(fn).text).toEqual({ format: { type: 'json_object' } });
  });

  it('places provider-executed web search before caller-executed function tools', async () => {
    const fn = mockFetch(jsonResponse({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Found it.' }] }],
    }));
    const provider = new OpenAIResponsesProvider('https://api.test');

    await provider.complete(
      [{ role: 'user', content: 'Find the latest information.' }],
      config,
      undefined,
      { providerTools: [{ type: 'web_search' }], tools },
    );

    expect(sentBody(fn).tools).toEqual([
      { type: 'web_search' },
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a record.',
        parameters: tools[0].parameters,
      },
    ]);
  });

  it('replays assistant history as output_text rather than input_text', async () => {
    const fn = mockFetch(jsonResponse({
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Second answer.' }],
      }],
    }));

    await new OpenAIResponsesProvider('https://api.test').complete([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer.' }] },
      { role: 'user', content: 'Second question.' },
    ], config);

    expect(sentBody(fn).input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'Be concise.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'First question.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'First answer.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Second question.' }] },
    ]);
  });

  it('parses visible text, safe summaries, cache usage, and reasoning usage', async () => {
    mockFetch(jsonResponse({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Checked the input.' }],
          encrypted_content: 'opaque',
        },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Hello ' },
            { type: 'output_text', text: 'world' },
          ],
        },
      ],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 25,
        output_tokens_details: { reasoning_tokens: 20 },
      },
    }));

    const result = await new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Hi' }],
      config,
    );

    expect(result).toMatchObject({
      text: 'Hello world',
      finishReason: 'stop',
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 25,
      reasoningTokens: 20,
      reasoning: { summary: 'Checked the input.' },
    });
    expect(result.reasoning?.continuation).toBeUndefined();
  });

  it('parses function calls and returns complete opaque reasoning only for continuation', async () => {
    mockFetch(jsonResponse({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Need a lookup.' }],
          encrypted_content: 'opaque',
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"id":"42"}',
        },
      ],
    }));

    const result = await new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Find 42.' }],
      config,
      undefined,
      { tools },
    );

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: { id: '42' } }]);
    expect(result.reasoning?.continuation).toEqual([{
      format: 'openai.responses.reasoning.v1',
      value: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Need a lookup.' }],
        encrypted_content: 'opaque',
      },
    }]);
  });

  it('never exposes or replays raw reasoning content fields', async () => {
    mockFetch(jsonResponse({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_raw',
          content: [{ type: 'reasoning_text', text: 'private trace' }],
          summary: [{ type: 'summary_text', text: 'Safe summary.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"id":"42"}',
        },
      ],
    }));
    const result = await new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Find 42.' }],
      config,
      undefined,
      { tools },
    );

    expect(result.reasoning).toEqual({ summary: 'Safe summary.', continuation: undefined });
    expect(JSON.stringify(result)).not.toContain('private trace');
  });

  it('replays opaque reasoning before function calls and function outputs', async () => {
    const fn = mockFetch(jsonResponse({ status: 'completed', output: [] }));
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        reasoning: {
          continuation: [{
            format: 'openai.responses.reasoning.v1',
            value: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
          }],
        },
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { id: '42' } }],
      },
      { role: 'tool', content: 'found', toolCallId: 'call_1', name: 'lookup' },
    ];

    await new OpenAIResponsesProvider().complete(messages, config);
    expect(sentBody(fn).input).toEqual([
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":"42"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ]);
  });

  it.each([
    ['max_output_tokens', 'length'],
    ['content_filter', 'content_filter'],
    ['other', 'unknown'],
  ])('maps incomplete reason %s to %s', async (reason, expected) => {
    mockFetch(jsonResponse({
      status: 'incomplete',
      incomplete_details: { reason },
      output: [],
    }));
    const result = await new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Hi' }],
      config,
    );
    expect(result.finishReason).toBe(expected);
  });

  it('maps failed Responses objects and HTTP failures to PROVIDER_ERROR', async () => {
    mockFetch(jsonResponse({
      status: 'failed',
      error: { code: 'server_error', message: 'bad response' },
    }));
    await expect(new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Hi' }],
      config,
    )).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    vi.unstubAllGlobals();
    mockFetch(jsonResponse({ error: 'nope' }, 500));
    await expect(new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Hi' }],
      config,
    )).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('OpenAIResponsesProvider streaming and cancellation', () => {
  it('parses fragmented CRLF semantic SSE without duplicating tool calls', async () => {
    const payload = [
      event({ type: 'response.reasoning_summary_text.delta', delta: 'Checking' }),
      event({ type: 'response.output_text.delta', delta: 'Let me check. ' }),
      event({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' },
      }),
      event({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"id":' }),
      event({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"42"}' }),
      event({
        type: 'response.function_call_arguments.done',
        output_index: 1,
        name: 'lookup',
        arguments: '{"id":"42"}',
      }),
      event({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              summary: [{ type: 'summary_text', text: 'Checking' }],
              encrypted_content: 'opaque',
            },
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":"42"}' },
          ],
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      }),
    ].join('');
    mockFetch(chunkedSseResponse([
      payload.slice(0, 17),
      payload.slice(17, 93),
      payload.slice(93, 211),
      payload.slice(211),
    ]));

    const events = await collectEvents(new OpenAIResponsesProvider().streamEvents(
      [{ role: 'user', content: 'Find 42.' }],
      config,
      undefined,
      { tools },
    ));

    expect(events.map(item => item.type)).toEqual([
      'reasoning_summary_delta',
      'text_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'finish',
    ]);
    expect(events.filter(item => item.type === 'tool_call_end')).toHaveLength(1);
    expect(events.find(item => item.type === 'usage')).toMatchObject({
      inputTokens: 10,
      outputTokens: 7,
      cachedInputTokens: 4,
      reasoningTokens: 3,
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'finish',
      finishReason: 'tool_calls',
      reasoning: {
        summary: 'Checking',
        continuation: [{
          format: 'openai.responses.reasoning.v1',
        }],
      },
    });
  });

  it('maps caller cancellation to REQUEST_ABORTED', async () => {
    const caller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      },
    )));

    const pending = new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Hi' }],
      config,
      undefined,
      { signal: caller.signal },
    );
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  it('maps the adapter timer to PROVIDER_TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      },
    )));

    await expect(new OpenAIResponsesProvider().complete(
      [{ role: 'user', content: 'Hi' }],
      { ...config, timeoutSeconds: 0 },
    )).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });
});
