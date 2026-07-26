import { PriestResponse, UsageInfo } from '../schema/PriestResponse';
import { ToolCall } from '../schema/ToolTypes';

/**
 * Structured streaming events yielded by PriestEngine.streamEvents().
 *
 * The terminal event is always 'done' carrying the full PriestResponse
 * (including toolCalls, usage, session info, and error state).
 */
export type PriestStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_summary_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id?: string; name?: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'tool_call_end'; index: number; toolCall: ToolCall }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'done'; response: PriestResponse };

/** Options accepted by engine run/stream/streamEvents calls. */
export interface RunOptions {
  /** Caller cancellation. Aborting rejects in-flight provider work. */
  signal?: AbortSignal;
}
