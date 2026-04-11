import { PriestError } from '../errors/PriestError';
import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { AdapterResult } from './AdapterResult';
import { Message, ProviderAdapter } from './ProviderAdapter';

/** Ollama provider. Uses NDJSON streaming via the /api/chat endpoint. */
export class OllamaProvider implements ProviderAdapter {
  constructor(private readonly baseUrl: string = 'http://localhost:11434') {}

  async complete(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult> {
    let text = '';
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const chunk of this.stream(messages, config, outputSpec)) {
      text += chunk;
    }
    // stream() does not surface usage — collect via non-streaming call
    finishReason = 'stop';

    return { text, finishReason, inputTokens, outputTokens };
  }

  async *stream(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      ...(config.providerOptions ?? {}),
    };
    if (outputSpec?.providerFormat === 'json') {
      body['format'] = 'json';
    }
    if (config.maxOutputTokens !== undefined) {
      body['options'] = { ...((body['options'] as object) ?? {}), num_predict: config.maxOutputTokens };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds ?? 60) * 1000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw PriestError.providerTimeout('ollama', config.timeoutSeconds ?? 60);
      }
      throw PriestError.providerError('ollama', String(err));
    }

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('ollama', `HTTP ${response.status}: ${errText}`);
    }

    if (!response.body) throw PriestError.providerError('ollama', 'No response body');

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
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
            const chunk = parsed.message?.content;
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
}
