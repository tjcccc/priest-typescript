import { PriestError } from '../errors/PriestError';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { AdapterResult } from './AdapterResult';
import { Message, ProviderAdapter } from './ProviderAdapter';

type FinishReason = 'stop' | 'length' | 'content_filter' | null;

/** OpenAI-compatible provider. Uses SSE streaming via /v1/chat/completions. */
export class OpenAICompatProvider implements ProviderAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async complete(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult> {
    let text = '';
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: false,
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds ?? 60) * 1000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw PriestError.providerTimeout('openai-compat', config.timeoutSeconds ?? 60);
      }
      throw PriestError.providerError('openai-compat', String(err));
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('openai-compat', `HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: FinishReason }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    text = data.choices[0]?.message?.content ?? '';
    const fr = data.choices[0]?.finish_reason;
    finishReason = fr ?? undefined;
    inputTokens = data.usage?.prompt_tokens;
    outputTokens = data.usage?.completion_tokens;

    return { text, finishReason, inputTokens, outputTokens };
  }

  async *stream(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds ?? 60) * 1000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw PriestError.providerTimeout('openai-compat', config.timeoutSeconds ?? 60);
      }
      throw PriestError.providerError('openai-compat', String(err));
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('openai-compat', `HTTP ${response.status}: ${errText}`);
    }

    if (!response.body) throw PriestError.providerError('openai-compat', 'No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data) as { choices: Array<{ delta?: { content?: string } }> };
            const chunk = parsed.choices[0]?.delta?.content;
            if (chunk) yield chunk;
          } catch {
            // skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }
}
