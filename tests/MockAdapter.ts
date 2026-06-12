import { AdapterResult } from '../src/providers/AdapterResult';
import { AdapterCallOptions, AdapterStreamEvent, Message, ProviderAdapter } from '../src/providers/ProviderAdapter';
import { OutputSpec } from '../src/schema/OutputSpec';
import { PriestConfig } from '../src/schema/PriestConfig';

export class MockAdapter implements ProviderAdapter {
  constructor(private readonly responseText: string = 'mock response') {}

  async complete(_messages: Message[], _config: PriestConfig, _outputSpec?: OutputSpec): Promise<AdapterResult> {
    return {
      text: this.responseText,
      finishReason: 'stop',
      inputTokens: 10,
      outputTokens: 5,
    };
  }

  async *stream(_messages: Message[], _config: PriestConfig, _outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    for (const word of this.responseText.split(' ')) {
      yield word;
    }
  }
}

/**
 * Adapter scripted with a sequence of AdapterResults — one per complete()
 * call. Records every messages array and call options it receives.
 */
export class ScriptedAdapter implements ProviderAdapter {
  readonly calls: Array<{ messages: Message[]; options?: AdapterCallOptions }> = [];
  private cursor = 0;

  constructor(private readonly results: AdapterResult[]) {}

  async complete(
    messages: Message[],
    _config: PriestConfig,
    _outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    this.calls.push({ messages, options });
    const result = this.results[Math.min(this.cursor, this.results.length - 1)];
    this.cursor += 1;
    return result;
  }

  async *stream(
    messages: Message[],
    _config: PriestConfig,
    _outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<string, void, unknown> {
    this.calls.push({ messages, options });
    const result = this.results[Math.min(this.cursor, this.results.length - 1)];
    this.cursor += 1;
    yield result.text;
  }
}

/** Adapter that emits a scripted AdapterStreamEvent sequence from streamEvents. */
export class EventScriptedAdapter implements ProviderAdapter {
  readonly calls: Array<{ messages: Message[]; options?: AdapterCallOptions }> = [];

  constructor(private readonly events: AdapterStreamEvent[]) {}

  async complete(_messages: Message[], _config: PriestConfig): Promise<AdapterResult> {
    throw new Error('EventScriptedAdapter only supports streaming');
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
    _config: PriestConfig,
    _outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<AdapterStreamEvent, void, unknown> {
    this.calls.push({ messages, options });
    for (const event of this.events) {
      yield event;
    }
  }
}
