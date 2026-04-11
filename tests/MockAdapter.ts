import { AdapterResult } from '../src/providers/AdapterResult';
import { Message, ProviderAdapter } from '../src/providers/ProviderAdapter';
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
