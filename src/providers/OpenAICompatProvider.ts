import { PriestError } from '../errors/PriestError';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { ToolCall, ToolChoice } from '../schema/ToolTypes';
import { createLinkedAbort, LinkedAbort } from '../util/Abort';
import { parseToolArguments } from '../util/ToolArgs';
import { AdapterResult } from './AdapterResult';
import { AdapterCallOptions, AdapterStreamEvent, Message, ProviderAdapter } from './ProviderAdapter';

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;

interface OpenAIToolCallWire {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIStreamToolCallWire extends OpenAIToolCallWire {
  index?: number;
}

interface OpenAIUsageWire {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Present on OpenAI/DashScope when prompt caching is active. */
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Options for hosts that wrap or rebrand an OpenAI-compatible endpoint. */
export interface OpenAICompatProviderOptions {
  /** Full chat-completions URL. Defaults to `${baseUrl}/v1/chat/completions`. */
  url?: string;
  /** Extra headers merged over the defaults (Content-Type, Authorization). */
  headers?: Record<string, string>;
}

/** OpenAI-compatible provider. Uses SSE streaming via /v1/chat/completions. */
export class OpenAICompatProvider implements ProviderAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly options: OpenAICompatProviderOptions = {},
  ) {}

  async complete(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    const body = this.buildBody(messages, config, outputSpec, options, false);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    try {
      const response = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: link.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw PriestError.providerError('openai-compat', `HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json() as {
        choices: Array<{
          message: { content: string | null; tool_calls?: OpenAIToolCallWire[] };
          finish_reason: FinishReason;
        }>;
        usage?: OpenAIUsageWire;
      };

      const choice = data.choices[0];
      const toolCalls = parseWireToolCalls(choice?.message?.tool_calls);
      return {
        text: choice?.message?.content ?? '',
        finishReason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(choice?.finish_reason ?? undefined),
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (err: unknown) {
      throw this.mapError(err, link, config);
    } finally {
      link.dispose();
    }
  }

  async *stream(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<string, void, unknown> {
    for await (const event of this.streamEvents(messages, config, outputSpec, options)) {
      if (event.type === 'text_delta') yield event.text;
    }
  }

  async *streamEvents(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<AdapterStreamEvent, void, unknown> {
    const body = this.buildBody(messages, config, outputSpec, options, true);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    let response: Response;
    try {
      response = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: link.signal,
      });
    } catch (err: unknown) {
      link.dispose();
      throw this.mapError(err, link, config);
    }
    // Keep the caller signal wired for the body read; only the connect timeout ends here.
    link.clearTimer();

    if (!response.ok) {
      link.dispose();
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('openai-compat', `HTTP ${response.status}: ${errText}`);
    }
    if (!response.body) {
      link.dispose();
      throw PriestError.providerError('openai-compat', 'No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Tool-call fragments accumulate per provider-reported index until the
    // stream finishes, then finalize in index order.
    const partials = new Map<number, { id?: string; name?: string; args: string }>();
    let finishReason: string | undefined;
    let usage: OpenAIUsageWire | undefined;
    let finalized = false;

    const finalize = function* (this: void): Generator<AdapterStreamEvent> {
      if (finalized) return;
      finalized = true;
      const indexes = [...partials.keys()].sort((a, b) => a - b);
      for (const index of indexes) {
        const partial = partials.get(index)!;
        yield {
          type: 'tool_call_end',
          index,
          toolCall: {
            id: partial.id ?? `call_${index}`,
            name: partial.name ?? '',
            arguments: parseToolArguments(partial.args),
          },
        };
      }
      if (usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
        yield {
          type: 'usage',
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
        };
      }
      yield {
        type: 'finish',
        finishReason: partials.size > 0 ? 'tool_calls' : (mapFinishReason(finishReason) ?? 'stop'),
      };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield* finalize();
            return;
          }
          let parsed: {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: OpenAIStreamToolCallWire[] };
              finish_reason?: FinishReason;
            }>;
            usage?: OpenAIUsageWire;
          };
          try {
            parsed = JSON.parse(data) as typeof parsed;
          } catch {
            continue; // skip malformed lines
          }
          if (parsed.usage) usage = parsed.usage;
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const chunk = choice.delta?.content;
          if (chunk) yield { type: 'text_delta', text: chunk };
          for (const fragment of choice.delta?.tool_calls ?? []) {
            const index = fragment.index ?? 0;
            let partial = partials.get(index);
            if (!partial) {
              partial = { id: fragment.id, name: fragment.function?.name, args: '' };
              partials.set(index, partial);
              yield { type: 'tool_call_start', index, id: partial.id, name: partial.name };
            } else {
              if (fragment.id) partial.id = fragment.id;
              if (fragment.function?.name) partial.name = fragment.function.name;
            }
            const argsDelta = fragment.function?.arguments;
            if (argsDelta) {
              partial.args += argsDelta;
              yield { type: 'tool_call_delta', index, argumentsDelta: argsDelta };
            }
          }
        }
      }
      yield* finalize();
    } catch (err: unknown) {
      throw this.mapError(err, link, config);
    } finally {
      reader.releaseLock();
      link.dispose();
    }
  }

  private buildBody(
    messages: Message[],
    config: PriestConfig,
    outputSpec: OutputSpec | undefined,
    options: AdapterCallOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOpenAIMessages(messages),
      stream,
      ...(config.providerOptions ?? {}),
    };
    if (outputSpec?.jsonSchema != null) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: outputSpec.jsonSchemaName ?? 'response',
          schema: outputSpec.jsonSchema,
          strict: outputSpec.jsonSchemaStrict ?? false,
        },
      };
    } else if (outputSpec?.providerFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }
    if (config.maxOutputTokens !== undefined) {
      body['max_tokens'] = config.maxOutputTokens;
    }
    if (options?.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? {} },
      }));
      if (options.toolChoice !== undefined) {
        body['tool_choice'] = mapToolChoice(options.toolChoice);
      }
    }
    return body;
  }

  private mapError(err: unknown, link: LinkedAbort, config: PriestConfig): Error {
    if (err instanceof PriestError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      if (link.callerAborted()) return PriestError.requestAborted('openai-compat');
      if (link.timedOut()) return PriestError.providerTimeout('openai-compat', config.timeoutSeconds ?? 60);
    }
    return PriestError.providerError('openai-compat', String(err));
  }

  private url(): string {
    return this.options.url ?? `${this.baseUrl}/v1/chat/completions`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return { ...h, ...(this.options.headers ?? {}) };
  }
}

/**
 * Translate adapter messages to OpenAI wire format. Multimodal content blocks
 * pass through unchanged (they are already OpenAI-format). Assistant tool
 * calls serialize arguments to JSON strings; tool turns carry tool_call_id.
 */
function toOpenAIMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: blockText(m.content) };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const text = blockText(m.content);
      return {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        tool_calls: m.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function blockText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' ');
}

function mapToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

// Mirrors the Python provider's _map_finish_reason table, extended with tool_calls.
function mapFinishReason(reason: string | undefined): string | undefined {
  if (reason == null) return undefined;
  const mapping: Record<string, string> = {
    stop: 'stop',
    length: 'length',
    content_filter: 'content_filter',
    tool_calls: 'tool_calls',
  };
  return mapping[reason] ?? 'unknown';
}

/** Parse non-streaming wire tool calls. Unparseable argument JSON becomes {}. */
function parseWireToolCalls(wire: OpenAIToolCallWire[] | undefined): ToolCall[] {
  if (!wire) return [];
  const calls: ToolCall[] = [];
  for (let i = 0; i < wire.length; i++) {
    const item = wire[i];
    const name = item.function?.name;
    if (!name) continue;
    calls.push({
      id: item.id ?? `call_${i}`,
      name,
      arguments: parseToolArguments(item.function?.arguments ?? ''),
    });
  }
  return calls;
}

