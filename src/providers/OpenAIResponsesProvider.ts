import { PriestError } from '../errors/PriestError';
import { JSONValue } from '../schema/JSONValue';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { OpaqueReasoningState, ReasoningInfo } from '../schema/Reasoning';
import { ToolCall, ToolChoice } from '../schema/ToolTypes';
import { createLinkedAbort, LinkedAbort } from '../util/Abort';
import { parseToolArguments } from '../util/ToolArgs';
import { AdapterResult } from './AdapterResult';
import {
  AdapterCallOptions,
  AdapterStreamEvent,
  ContentBlock,
  Message,
  ProviderAdapter,
} from './ProviderAdapter';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const REASONING_FORMAT = 'openai.responses.reasoning.v1';

interface ResponsesUsageWire {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

interface ResponsesOutputItemWire {
  [key: string]: unknown;
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
  encrypted_content?: string;
}

interface ResponsesWire {
  status?: string;
  output?: ResponsesOutputItemWire[];
  usage?: ResponsesUsageWire;
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string };
}

interface PartialToolCall {
  eventIndex: number;
  callId?: string;
  name?: string;
  arguments: string;
  ended: boolean;
}

/** Options for the first-class OpenAI Responses endpoint. */
export interface OpenAIResponsesProviderOptions {
  /** Full Responses URL. Defaults to `${baseUrl}/v1/responses`. */
  url?: string;
  /** Extra headers merged over Content-Type and Authorization defaults. */
  headers?: Record<string, string>;
  /** Optional undici dispatcher, typed as unknown to avoid a hard dependency. */
  dispatcher?: unknown;
}

/**
 * First-class OpenAI Responses provider.
 *
 * This provider is separate from OpenAICompatProvider and does not alter the
 * latter's Chat Completions wire behavior.
 */
export class OpenAIResponsesProvider implements ProviderAdapter {
  constructor(
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly apiKey?: string,
    private readonly options: OpenAIResponsesProviderOptions = {},
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
        ...(this.options.dispatcher ? { dispatcher: this.options.dispatcher } : {}),
      } as RequestInit);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw PriestError.providerError('openai-responses', `HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json() as ResponsesWire;
      return parseResponse(data);
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
        ...(this.options.dispatcher ? { dispatcher: this.options.dispatcher } : {}),
      } as RequestInit);
    } catch (err: unknown) {
      link.dispose();
      throw this.mapError(err, link, config);
    }

    link.clearTimer();

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      link.dispose();
      throw PriestError.providerError('openai-responses', `HTTP ${response.status}: ${errText}`);
    }
    if (!response.body) {
      link.dispose();
      throw PriestError.providerError('openai-responses', 'No response body');
    }

    const reader = response.body.getReader();
    const partials = new Map<number, PartialToolCall>();
    const emittedCallIds = new Set<string>();
    let nextEventIndex = 0;
    let terminalSeen = false;

    const ensurePartial = (outputIndex: number, item?: ResponsesOutputItemWire): PartialToolCall => {
      let partial = partials.get(outputIndex);
      if (!partial) {
        partial = {
          eventIndex: nextEventIndex++,
          callId: item?.call_id,
          name: item?.name,
          arguments: item?.arguments ?? '',
          ended: false,
        };
        partials.set(outputIndex, partial);
      } else if (item) {
        partial.callId = item.call_id ?? partial.callId;
        partial.name = item.name ?? partial.name;
        if (item.arguments !== undefined) partial.arguments = item.arguments;
      }
      return partial;
    };

    const finishPartial = (partial: PartialToolCall): AdapterStreamEvent | undefined => {
      if (partial.ended) return undefined;
      partial.ended = true;
      const id = partial.callId ?? `call_${partial.eventIndex}`;
      emittedCallIds.add(id);
      return {
        type: 'tool_call_end',
        index: partial.eventIndex,
        toolCall: {
          id,
          name: partial.name ?? '',
          arguments: parseToolArguments(partial.arguments),
        },
      };
    };

    try {
      for await (const data of readSseData(reader)) {
        if (data === '[DONE]') break;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = typeof event['type'] === 'string' ? event['type'] : '';
        if (type === 'response.output_text.delta') {
          const delta = event['delta'];
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'text_delta', text: delta };
          }
          continue;
        }

        if (type === 'response.reasoning_summary_text.delta') {
          const delta = event['delta'];
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'reasoning_summary_delta', text: delta };
          }
          continue;
        }

        if (type === 'response.output_item.added') {
          const item = asOutputItem(event['item']);
          if (item?.type !== 'function_call') continue;
          const outputIndex = numberOr(event['output_index'], partials.size);
          const partial = ensurePartial(outputIndex, item);
          yield {
            type: 'tool_call_start',
            index: partial.eventIndex,
            id: partial.callId,
            name: partial.name,
          };
          continue;
        }

        if (type === 'response.function_call_arguments.delta') {
          const outputIndex = numberOr(event['output_index'], 0);
          const partial = ensurePartial(outputIndex);
          const delta = event['delta'];
          if (typeof delta === 'string' && delta.length > 0) {
            partial.arguments += delta;
            yield {
              type: 'tool_call_delta',
              index: partial.eventIndex,
              argumentsDelta: delta,
            };
          }
          continue;
        }

        if (type === 'response.function_call_arguments.done') {
          const outputIndex = numberOr(event['output_index'], 0);
          const partial = ensurePartial(outputIndex);
          if (typeof event['arguments'] === 'string') partial.arguments = event['arguments'];
          if (typeof event['name'] === 'string') partial.name = event['name'];
          const finished = finishPartial(partial);
          if (finished) yield finished;
          continue;
        }

        if (type === 'response.output_item.done') {
          const item = asOutputItem(event['item']);
          if (item?.type !== 'function_call') continue;
          const outputIndex = numberOr(event['output_index'], 0);
          const partial = ensurePartial(outputIndex, item);
          const finished = finishPartial(partial);
          if (finished) yield finished;
          continue;
        }

        if (type === 'response.completed') {
          terminalSeen = true;
          const wire = asResponsesWire(event['response']);
          const parsed = parseResponse(wire);

          for (const partial of [...partials.values()].sort((a, b) => a.eventIndex - b.eventIndex)) {
            const finished = finishPartial(partial);
            if (finished) yield finished;
          }
          for (const call of parsed.toolCalls ?? []) {
            if (emittedCallIds.has(call.id)) continue;
            const index = nextEventIndex++;
            yield { type: 'tool_call_start', index, id: call.id, name: call.name };
            yield { type: 'tool_call_end', index, toolCall: call };
            emittedCallIds.add(call.id);
          }

          if (
            parsed.inputTokens !== undefined
            || parsed.outputTokens !== undefined
            || parsed.cachedInputTokens !== undefined
            || parsed.reasoningTokens !== undefined
          ) {
            yield {
              type: 'usage',
              inputTokens: parsed.inputTokens,
              outputTokens: parsed.outputTokens,
              cachedInputTokens: parsed.cachedInputTokens,
              reasoningTokens: parsed.reasoningTokens,
            };
          }
          yield {
            type: 'finish',
            finishReason: parsed.finishReason,
            reasoning: parsed.reasoning,
          };
          return;
        }

        if (type === 'response.failed' || type === 'response.cancelled') {
          terminalSeen = true;
          const wire = asResponsesWire(event['response']);
          throw providerResponseError(wire);
        }

        if (type === 'error') {
          terminalSeen = true;
          const message = typeof event['message'] === 'string'
            ? event['message']
            : JSON.stringify(event);
          throw PriestError.providerError('openai-responses', message);
        }
      }

      for (const partial of [...partials.values()].sort((a, b) => a.eventIndex - b.eventIndex)) {
        const finished = finishPartial(partial);
        if (finished) yield finished;
      }
      if (!terminalSeen) {
        yield {
          type: 'finish',
          finishReason: partials.size > 0 ? 'tool_calls' : 'stop',
        };
      }
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
    const generated: Record<string, unknown> = {
      store: false,
    };

    if (config.maxOutputTokens !== undefined) {
      generated['max_output_tokens'] = config.maxOutputTokens;
    }

    const reasoning = toOpenAIReasoning(config);
    if (reasoning) generated['reasoning'] = reasoning;

    if (outputSpec?.jsonSchema != null) {
      generated['text'] = {
        format: {
          type: 'json_schema',
          name: outputSpec.jsonSchemaName ?? 'response',
          schema: outputSpec.jsonSchema,
          strict: outputSpec.jsonSchemaStrict ?? false,
        },
      };
    } else if (outputSpec?.providerFormat === 'json') {
      generated['text'] = { format: { type: 'json_object' } };
    }

    if (options?.tools && options.tools.length > 0) {
      generated['tools'] = options.tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? {},
      }));
      if (options.toolChoice !== undefined) {
        generated['tool_choice'] = mapToolChoice(options.toolChoice);
      }
    }

    return {
      ...generated,
      ...(config.providerOptions ?? {}),
      model: config.model,
      input: toResponsesInput(messages),
      stream,
    };
  }

  private mapError(err: unknown, link: LinkedAbort, config: PriestConfig): Error {
    if (err instanceof PriestError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      if (link.callerAborted()) return PriestError.requestAborted('openai-responses');
      if (link.timedOut()) {
        return PriestError.providerTimeout('openai-responses', config.timeoutSeconds ?? 60);
      }
    }
    return PriestError.providerError('openai-responses', String(err));
  }

  private url(): string {
    if (this.options.url) return this.options.url;
    return `${this.baseUrl.replace(/\/+$/, '')}/v1/responses`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return { ...headers, ...(this.options.headers ?? {}) };
  }
}

function parseResponse(data: ResponsesWire): AdapterResult {
  if (data.status === 'failed' || data.status === 'cancelled' || data.error) {
    throw providerResponseError(data);
  }

  const output = data.output ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const summaryParts: string[] = [];
  const reasoningStates: OpaqueReasoningState[] = [];

  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
      continue;
    }

    if (item.type === 'function_call' && item.name) {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        name: item.name,
        arguments: parseToolArguments(item.arguments ?? ''),
      });
      continue;
    }

    if (item.type === 'reasoning') {
      for (const part of item.summary ?? []) {
        if (part.type === 'summary_text' && typeof part.text === 'string' && part.text.length > 0) {
          summaryParts.push(part.text);
        }
      }
      const state = safeOpenAIReasoningState(item);
      if (state) reasoningStates.push(state);
    }
  }

  const hasTools = toolCalls.length > 0;
  const reasoning = buildReasoningInfo(
    summaryParts,
    hasTools ? reasoningStates : [],
  );

  return {
    text: textParts.join(''),
    finishReason: mapResponseFinish(data, hasTools),
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
    cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens,
    reasoningTokens: data.usage?.output_tokens_details?.reasoning_tokens,
    toolCalls: hasTools ? toolCalls : undefined,
    reasoning,
  };
}

function safeOpenAIReasoningState(
  item: ResponsesOutputItemWire,
): OpaqueReasoningState | undefined {
  // Some open-weight models can expose raw reasoning in a `content` field.
  // Priest deliberately does not surface or replay that field. Standard
  // Responses reasoning continuation uses the encrypted envelope below.
  if (item.content && item.content.length > 0) return undefined;

  const value: { [key: string]: JSONValue } = { type: 'reasoning' };
  if (item.id !== undefined) value['id'] = item.id;
  if (typeof item['status'] === 'string') value['status'] = item['status'];
  if (item.summary !== undefined) value['summary'] = item.summary as JSONValue;
  if (item.encrypted_content !== undefined) value['encrypted_content'] = item.encrypted_content;

  if (item.encrypted_content === undefined && item.id === undefined) return undefined;
  return { format: REASONING_FORMAT, value };
}

function buildReasoningInfo(
  summaries: string[],
  continuation: OpaqueReasoningState[],
): ReasoningInfo | undefined {
  const summary = summaries.length > 0 ? summaries.join('\n\n') : undefined;
  if (!summary && continuation.length === 0) return undefined;
  return {
    summary,
    continuation: continuation.length > 0 ? continuation : undefined,
  };
}

function mapResponseFinish(data: ResponsesWire, hasTools: boolean): string {
  if (hasTools) return 'tool_calls';
  if (data.status === 'incomplete') {
    if (data.incomplete_details?.reason === 'max_output_tokens') return 'length';
    if (data.incomplete_details?.reason === 'content_filter') return 'content_filter';
    return 'unknown';
  }
  if (data.status === undefined || data.status === 'completed') return 'stop';
  return 'unknown';
}

function providerResponseError(data: ResponsesWire): PriestError {
  const code = data.error?.code ? `${data.error.code}: ` : '';
  const message = data.error?.message ?? `response status ${data.status ?? 'failed'}`;
  return PriestError.providerError('openai-responses', `${code}${message}`);
}

function toResponsesInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: contentText(message.content),
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      for (const state of message.reasoning?.continuation ?? []) {
        if (state.format === REASONING_FORMAT) input.push(state.value);
      }
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }

    input.push({
      role: message.role,
      content: toResponsesContent(message.content, message.role === 'assistant'),
    });
  }

  return input;
}

function toResponsesContent(
  content: Message['content'],
  assistantOutput: boolean,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: assistantOutput ? 'output_text' : 'input_text', text: content }];
  }
  return content.map(block => toResponsesContentBlock(block, assistantOutput));
}

function toResponsesContentBlock(block: ContentBlock, assistantOutput: boolean): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: assistantOutput ? 'output_text' : 'input_text', text: block.text };
  }
  return { type: 'input_image', image_url: block.image_url.url };
}

function contentText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join(' ');
}

function toOpenAIReasoning(config: PriestConfig): Record<string, unknown> | undefined {
  const requested = config.reasoning;
  if (!requested) return undefined;

  const reasoning: Record<string, unknown> = {};
  if (requested.effort !== undefined) {
    reasoning['effort'] = requested.effort;
  } else if (requested.enabled === false) {
    reasoning['effort'] = 'none';
  }
  if (requested.summary === 'auto') reasoning['summary'] = 'auto';
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

function mapToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

function asOutputItem(value: unknown): ResponsesOutputItemWire | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as ResponsesOutputItemWire;
}

function asResponsesWire(value: unknown): ResponsesWire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ResponsesWire;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

async function* readSseData(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = sseFrameData(frame);
      if (data !== undefined) yield data;
    }
  }

  if (buffer.trim().length > 0) {
    const data = sseFrameData(buffer);
    if (data !== undefined) yield data;
  }
}

function sseFrameData(frame: string): string | undefined {
  const dataLines = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''));
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}
