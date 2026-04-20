import { JSONValue } from './JSONValue';

/** Provider and model configuration for a single priest run. */
export interface PriestConfig {
  /** Registered provider name. Must match a key in the engine's adapter registry. */
  provider: string;
  /** Model identifier passed directly to the provider. */
  model: string;
  /** Request timeout in seconds. Defaults to 60. */
  timeoutSeconds?: number;
  /** Maximum tokens to generate. Omitted from provider request if undefined. */
  maxOutputTokens?: number;
  /** Advisory cost ceiling in USD. The engine does NOT enforce this. */
  costLimit?: number;
  /** Budget for the assembled system prompt in characters. Triggers tail-trim of memory entries when exceeded. */
  maxSystemChars?: number;
  /**
   * Provider-specific options merged directly into the request payload.
   * Examples: { think: false } for Ollama/Qwen3, { temperature: 0.7 }.
   */
  providerOptions?: Record<string, JSONValue>;
}
