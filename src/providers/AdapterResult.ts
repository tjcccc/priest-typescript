import { ToolCall } from '../schema/ToolTypes';

/** Result returned by a provider adapter after a complete (non-streaming) call. */
export interface AdapterResult {
  text: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Portion of inputTokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
  /** Tool calls requested by the model. Undefined when none. */
  toolCalls?: ToolCall[];
}
