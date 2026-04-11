import { PriestError } from '../errors/PriestError';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { AdapterResult } from './AdapterResult';
import { Message, ProviderAdapter } from './ProviderAdapter';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

/** Anthropic provider. Uses SSE streaming via /v1/messages. */
export class AnthropicProvider implements ProviderAdapter {
  constructor(private readonly apiKey: string) {}

  async complete(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult> {
    const { system, chatMessages } = this.splitMessages(messages);
    const body = this.buildBody(config, chatMessages, system, outputSpec, false);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds ?? 60) * 1000);

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw PriestError.providerTimeout('anthropic', config.timeoutSeconds ?? 60);
      }
      throw PriestError.providerError('anthropic', String(err));
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('anthropic', `HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const text = data.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    return {
      text,
      finishReason: data.stop_reason ?? undefined,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    };
  }

  async *stream(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    const { system, chatMessages } = this.splitMessages(messages);
    const body = this.buildBody(config, chatMessages, system, outputSpec, true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds ?? 60) * 1000);

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw PriestError.providerTimeout('anthropic', config.timeoutSeconds ?? 60);
      }
      throw PriestError.providerError('anthropic', String(err));
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('anthropic', `HTTP ${response.status}: ${errText}`);
    }

    if (!response.body) throw PriestError.providerError('anthropic', 'No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

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
          } else if (trimmed.startsWith('data: ') && currentEvent === 'content_block_delta') {
            try {
              const parsed = JSON.parse(trimmed.slice(6)) as { delta?: { type?: string; text?: string } };
              if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                yield parsed.delta.text;
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private splitMessages(messages: Message[]): { system: string; chatMessages: Message[] } {
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const chatMessages = messages.filter(m => m.role !== 'system');
    return { system: systemParts.join('\n\n'), chatMessages };
  }

  private buildBody(
    config: PriestConfig,
    chatMessages: Message[],
    system: string,
    _outputSpec: OutputSpec | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages: chatMessages,
      stream,
      ...(config.providerOptions ?? {}),
    };
    if (system) body['system'] = system;
    return body;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }
}
