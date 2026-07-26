import { PriestError } from '../errors/PriestError';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { JSONValue } from '../schema/JSONValue';
import { ToolCall } from '../schema/ToolTypes';
import { createLinkedAbort, LinkedAbort } from '../util/Abort';
import { AdapterResult } from './AdapterResult';
import { AdapterCallOptions, AdapterStreamEvent, Message, ProviderAdapter } from './ProviderAdapter';

interface OllamaToolCallWire {
  function?: { name?: string; arguments?: Record<string, JSONValue> };
}

interface OllamaChunk {
  message?: { content?: string; tool_calls?: OllamaToolCallWire[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Ollama provider. Uses NDJSON streaming via the /api/chat endpoint. */
export class OllamaProvider implements ProviderAdapter {
  constructor(private readonly baseUrl: string = 'http://localhost:11434') {}

  async complete(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    const body = this.buildBody(messages, config, outputSpec, options, false);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: link.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw PriestError.providerError('ollama', `HTTP ${response.status}: ${errText}`);
      }
      const data = await response.json() as OllamaChunk;

      const toolCalls = parseToolCalls(data.message?.tool_calls);
      return {
        text: data.message?.content ?? '',
        finishReason: toolCalls.length > 0 ? 'tool_calls' : mapDoneReason(data.done_reason),
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
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
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      throw PriestError.providerError('ollama', `HTTP ${response.status}: ${errText}`);
    }
    if (!response.body) {
      link.dispose();
      throw PriestError.providerError('ollama', 'No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCallIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: OllamaChunk;
          try {
            parsed = JSON.parse(trimmed) as OllamaChunk;
          } catch {
            continue; // skip malformed lines
          }
          const chunk = parsed.message?.content;
          if (chunk) yield { type: 'text_delta', text: chunk };
          // Ollama delivers each tool call whole in one chunk — emit start/end pairs.
          for (const call of parseToolCalls(parsed.message?.tool_calls, toolCallIndex)) {
            yield { type: 'tool_call_start', index: toolCallIndex, id: call.id, name: call.name };
            yield { type: 'tool_call_end', index: toolCallIndex, toolCall: call };
            toolCallIndex += 1;
          }
          if (parsed.done) {
            if (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined) {
              yield { type: 'usage', inputTokens: parsed.prompt_eval_count, outputTokens: parsed.eval_count };
            }
            yield {
              type: 'finish',
              finishReason: toolCallIndex > 0 ? 'tool_calls' : mapDoneReason(parsed.done_reason),
            };
          }
        }
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
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOllamaMessages(messages),
      stream,
      ...toOllamaReasoningConfig(config),
      ...(config.providerOptions ?? {}),
    };
    if (outputSpec?.jsonSchema != null) {
      body['format'] = outputSpec.jsonSchema;
    } else if (outputSpec?.providerFormat === 'json') {
      body['format'] = 'json';
    }
    if (config.maxOutputTokens !== undefined) {
      body['options'] = { ...((body['options'] as object) ?? {}), num_predict: config.maxOutputTokens };
    }
    if (options?.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? {} },
      }));
      // Ollama has no tool_choice parameter — toolChoice is ignored.
    }
    return body;
  }

  private mapError(err: unknown, link: LinkedAbort, config: PriestConfig): Error {
    if (err instanceof PriestError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      if (link.callerAborted()) return PriestError.requestAborted('ollama');
      if (link.timedOut()) return PriestError.providerTimeout('ollama', config.timeoutSeconds ?? 60);
    }
    return PriestError.providerError('ollama', String(err));
  }
}

/**
 * Translate adapter messages to Ollama's format. Multimodal content blocks
 * become a top-level base64 'images' array (mirrors Python _translate_messages);
 * HTTP/HTTPS image URLs are rejected. Tool turns use tool_name; assistant tool
 * calls drop the synthesized id on the wire.
 */
function toOllamaMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', content: contentText(m.content), tool_name: m.name };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: contentText(m.content),
        tool_calls: m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.arguments } })),
      };
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const textParts: string[] = [];
      const imageB64s: string[] = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else {
          const url = block.image_url.url;
          if (url.startsWith('data:')) {
            imageB64s.push(url.slice(url.indexOf(',') + 1));
          } else {
            throw PriestError.providerError(
              'ollama',
              'Ollama requires base64 images; HTTP/HTTPS URLs are not supported. '
              + 'Use ImageInput path or data instead.',
            );
          }
        }
      }
      const msg: Record<string, unknown> = { role: 'user', content: textParts.join(' ') };
      if (imageB64s.length > 0) msg['images'] = imageB64s;
      return msg;
    }
    return { role: m.role, content: contentText(m.content) };
  });
}

function contentText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' ');
}

// Mirrors the Python provider's _map_finish_reason table.
function mapDoneReason(reason: string | undefined): string {
  if (reason == null) return 'stop';
  const mapping: Record<string, string> = { stop: 'stop', length: 'length', load: 'stop' };
  return mapping[reason] ?? 'unknown';
}

function toOllamaReasoningConfig(config: PriestConfig): Record<string, unknown> {
  const requested = config.reasoning;
  if (!requested) return {};
  if (requested.enabled === false || requested.effort === 'none') return { think: false };
  if (requested.effort === 'minimal' || requested.effort === 'xhigh') {
    throw new PriestError(
      'REQUEST_INVALID',
      `Ollama does not define the reasoning effort '${requested.effort}'`,
      { provider: 'ollama', effort: requested.effort },
    );
  }
  if (requested.effort) return { think: requested.effort };
  if (requested.enabled === true) return { think: true };
  return {};
}

/** Parse Ollama wire tool calls, synthesizing ids 'call_N' in response order. */
function parseToolCalls(wire: OllamaToolCallWire[] | undefined, startIndex = 0): ToolCall[] {
  if (!wire) return [];
  const calls: ToolCall[] = [];
  for (const item of wire) {
    const name = item.function?.name;
    if (!name) continue;
    calls.push({
      id: `call_${startIndex + calls.length}`,
      name,
      arguments: item.function?.arguments ?? {},
    });
  }
  return calls;
}
