import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { AdapterResult } from './AdapterResult';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Interface that all provider adapters must implement. */
export interface ProviderAdapter {
  /** Execute a request and return the full response. */
  complete(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult>;
  /** Yield text chunks as they arrive. */
  stream(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown>;
}
