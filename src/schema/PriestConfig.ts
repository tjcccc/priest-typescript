import { JSONValue } from './JSONValue';
import { ReasoningConfig } from './Reasoning';

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
   * Conversation-context budget in tokens. When set, the engine compacts a
   * session (folding older turns into a running summary) once a turn's
   * provider-reported input usage exceeds ~80% of this. Unset disables
   * compaction entirely (default — fully backward compatible).
   */
  maxContextTokens?: number;
  /** Recent turns kept verbatim when compacting; older turns fold into the summary. Defaults to 6. */
  compactionKeepTurns?: number;
  /**
   * Hard cap on how many recent session turns are replayed into a request. When
   * set, only the last N turns (after any compaction summary) reach the model;
   * older turns stay on disk but are not sent. 0 replays none (summary only).
   * Unset replays all turns (default — fully backward compatible). Independent
   * of `maxContextTokens`, which remains a budget-triggered safety net.
   */
  sessionContextTurns?: number;
  /** Provider-neutral reasoning request. Omission preserves provider/model defaults. */
  reasoning?: ReasoningConfig;
  /**
   * Provider-specific options merged directly into the request payload.
   * Examples: { think: false } for Ollama/Qwen3, { temperature: 0.7 }.
   */
  providerOptions?: Record<string, JSONValue>;
}
