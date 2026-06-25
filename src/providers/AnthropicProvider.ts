import { PriestError } from '../errors/PriestError';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { JSONValue } from '../schema/JSONValue';
import { ToolCall, ToolChoice } from '../schema/ToolTypes';
import { createLinkedAbort, LinkedAbort } from '../util/Abort';
import { parseToolArguments } from '../util/ToolArgs';
import { AdapterResult } from './AdapterResult';
import { AdapterCallOptions, AdapterStreamEvent, ContentBlock, Message, ProviderAdapter } from './ProviderAdapter';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Spec-defined default (behavior/providers.md): Anthropic requires max_tokens.
const DEFAULT_MAX_TOKENS = 8096;

interface AnthropicContentBlockWire {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, JSONValue>;
}

/** Anthropic provider. Uses SSE streaming via /v1/messages. */
export class AnthropicProvider implements ProviderAdapter {
  constructor(private readonly apiKey: string) {}

  async complete(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    const { system, chatMessages } = splitMessages(messages);
    const body = this.buildBody(config, chatMessages, system, outputSpec, options, false);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: link.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw PriestError.providerError('anthropic', `HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json() as {
        content: AnthropicContentBlockWire[];
        stop_reason?: string;
        usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
      };

      const text = data.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      const toolCalls: ToolCall[] = data.content
        .filter(b => b.type === 'tool_use' && b.name)
        .map((b, i) => ({ id: b.id ?? `call_${i}`, name: b.name!, arguments: b.input ?? {} }));

      return {
        text,
        finishReason: mapStopReason(data.stop_reason, toolCalls.length > 0),
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        cachedInputTokens: data.usage?.cache_read_input_tokens,
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
    const { system, chatMessages } = splitMessages(messages);
    const body = this.buildBody(config, chatMessages, system, outputSpec, options, true);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
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
      throw PriestError.providerError('anthropic', `HTTP ${response.status}: ${errText}`);
    }
    if (!response.body) {
      link.dispose();
      throw PriestError.providerError('anthropic', 'No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    // Anthropic block index -> in-progress tool call state. Tool-call event
    // indexes are assigned in tool_use block order, independent of text blocks.
    const toolBlocks = new Map<number, { toolIndex: number; id?: string; name?: string; json: string }>();
    let toolCount = 0;
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;
          let parsed: {
            index?: number;
            content_block?: AnthropicContentBlockWire;
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          try {
            parsed = JSON.parse(trimmed.slice(6)) as typeof parsed;
          } catch {
            continue; // skip malformed lines
          }

          switch (currentEvent) {
            case 'message_start':
              inputTokens = parsed.message?.usage?.input_tokens ?? inputTokens;
              cachedInputTokens = parsed.message?.usage?.cache_read_input_tokens ?? cachedInputTokens;
              break;
            case 'content_block_start': {
              const block = parsed.content_block;
              if (block?.type === 'tool_use' && parsed.index !== undefined) {
                const toolIndex = toolCount++;
                toolBlocks.set(parsed.index, { toolIndex, id: block.id, name: block.name, json: '' });
                yield { type: 'tool_call_start', index: toolIndex, id: block.id, name: block.name };
              }
              break;
            }
            case 'content_block_delta': {
              if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                yield { type: 'text_delta', text: parsed.delta.text };
              } else if (parsed.delta?.type === 'input_json_delta' && parsed.index !== undefined) {
                const state = toolBlocks.get(parsed.index);
                const fragment = parsed.delta.partial_json ?? '';
                if (state && fragment) {
                  state.json += fragment;
                  yield { type: 'tool_call_delta', index: state.toolIndex, argumentsDelta: fragment };
                }
              }
              break;
            }
            case 'content_block_stop': {
              if (parsed.index === undefined) break;
              const state = toolBlocks.get(parsed.index);
              if (state) {
                toolBlocks.delete(parsed.index);
                yield {
                  type: 'tool_call_end',
                  index: state.toolIndex,
                  toolCall: {
                    id: state.id ?? `call_${state.toolIndex}`,
                    name: state.name ?? '',
                    arguments: parseToolArguments(state.json),
                  },
                };
              }
              break;
            }
            case 'message_delta':
              stopReason = parsed.delta?.stop_reason ?? stopReason;
              outputTokens = parsed.usage?.output_tokens ?? outputTokens;
              break;
          }
        }
      }

      if (inputTokens !== undefined || outputTokens !== undefined) {
        yield { type: 'usage', inputTokens, outputTokens, cachedInputTokens };
      }
      yield { type: 'finish', finishReason: mapStopReason(stopReason, toolCount > 0) };
    } catch (err: unknown) {
      throw this.mapError(err, link, config);
    } finally {
      reader.releaseLock();
      link.dispose();
    }
  }

  private buildBody(
    config: PriestConfig,
    chatMessages: Array<Record<string, unknown>>,
    system: string,
    outputSpec: OutputSpec | undefined,
    options: AdapterCallOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    let systemText = system;
    if (outputSpec?.jsonSchema != null) {
      const instruction =
        'Respond with a valid JSON object that conforms to the following JSON Schema:\n\n' +
        `<schema>\n${JSON.stringify(outputSpec.jsonSchema, null, 2)}\n</schema>\n\n` +
        'Return only the JSON object — no explanation, no markdown fences.';
      systemText = systemText ? `${systemText}\n\n${instruction}` : instruction;
    }
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages: chatMessages,
      stream,
      ...(config.providerOptions ?? {}),
    };
    if (systemText) body['system'] = systemText;
    if (options?.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
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
      if (link.callerAborted()) return PriestError.requestAborted('anthropic');
      if (link.timedOut()) return PriestError.providerTimeout('anthropic', config.timeoutSeconds ?? 60);
    }
    return PriestError.providerError('anthropic', String(err));
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }
}

/**
 * Split system messages out and translate the rest to Anthropic wire format.
 *
 * Tool-result turns become user messages with tool_result blocks; consecutive
 * tool turns merge into one user message (Anthropic requires alternating
 * roles). Assistant tool calls become tool_use content blocks. OpenAI-format
 * image_url blocks become Anthropic image blocks.
 */
function splitMessages(messages: Message[]): { system: string; chatMessages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const chatMessages: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> | null = null;

  const flushToolResults = () => {
    if (pendingToolResults) {
      chatMessages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : blockText(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const block: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: blockText(m.content),
      };
      pendingToolResults = pendingToolResults ?? [];
      pendingToolResults.push(block);
      continue;
    }
    flushToolResults();
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      const text = blockText(m.content);
      if (text.length > 0) blocks.push({ type: 'text', text });
      for (const call of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      chatMessages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (Array.isArray(m.content)) {
      chatMessages.push({ role: m.role, content: m.content.map(toAnthropicBlock) });
      continue;
    }
    chatMessages.push({ role: m.role, content: m.content });
  }
  flushToolResults();

  return { system: systemParts.join('\n\n'), chatMessages };
}

function toAnthropicBlock(block: ContentBlock): Record<string, unknown> {
  if (block.type === 'text') return { type: 'text', text: block.text };
  const url = block.image_url.url;
  if (url.startsWith('data:')) {
    const mediaType = url.slice(5, url.indexOf(';'));
    const data = url.slice(url.indexOf(',') + 1);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function blockText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' ');
}

function mapToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === 'string') {
    if (choice === 'required') return { type: 'any' };
    return { type: choice };
  }
  return { type: 'tool', name: choice.name };
}

// Mirrors the Python provider's _map_finish_reason table, extended with tool_use.
function mapStopReason(stopReason: string | undefined, hasToolCalls: boolean): string | undefined {
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_calls';
  if (stopReason == null) return undefined;
  const mapping: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop' };
  return mapping[stopReason] ?? 'unknown';
}

