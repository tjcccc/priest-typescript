import { JSONValue } from './JSONValue';
import { ReasoningInfo } from './Reasoning';

/**
 * A tool the model may call. The SDK transports tool definitions and calls;
 * it never executes tools itself — execution is the caller's responsibility.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema object describing the tool's parameters. */
  parameters?: Record<string, JSONValue>;
}

/**
 * Tool selection behavior.
 * 'auto' lets the model decide, 'none' disables calls, 'required' forces a call,
 * and { name } forces a specific tool.
 */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** A single tool call requested by the model. */
export interface ToolCall {
  /**
   * Provider-assigned call id. Ollama does not assign ids, so adapters
   * synthesize 'call_0', 'call_1', ... in response order.
   */
  id: string;
  name: string;
  /** Parsed arguments. {} when the provider returned unparseable JSON. */
  arguments: Record<string, JSONValue>;
}

/**
 * One entry in the turn-local tool loop history.
 *
 * Callers replay the full exchange on each loop iteration via
 * PriestRequest.toolExchange. Exchange turns are never persisted in sessions —
 * only the original user prompt and the final assistant text are stored.
 */
export type ToolExchangeTurn =
  | { kind: 'assistant'; text?: string; toolCalls: ToolCall[]; reasoning?: ReasoningInfo }
  | { kind: 'tool_result'; toolCallId: string; name: string; content: string; isError?: boolean };
