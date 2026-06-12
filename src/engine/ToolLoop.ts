import { PriestRequest } from '../schema/PriestRequest';
import { PriestResponse } from '../schema/PriestResponse';
import { ToolCall, ToolExchangeTurn } from '../schema/ToolTypes';
import { PriestEngine } from './PriestEngine';
import { RunOptions } from './StreamEvents';

const DEFAULT_MAX_ITERATIONS = 10;

/** Executes one tool call. Errors should be returned as content with isError. */
export type ToolExecutor = (call: ToolCall) => Promise<{ content: string; isError?: boolean }>;

export interface ToolLoopHooks {
  /**
   * Approval gate called before each tool execution. When it returns
   * approved: false, the tool is not executed and a denial tool_result
   * is injected so the model can react. Defaults to approving everything.
   */
  onToolCall?: (call: ToolCall) => Promise<{ approved: boolean; reason?: string }>;
  /** Caller cancellation, threaded into every engine run. */
  signal?: AbortSignal;
  /** Maximum engine runs (model turns), not tool executions. Default 10. */
  maxIterations?: number;
}

export interface ToolLoopResult {
  /** The final response — the first one without tool calls, or the last
   * iteration's response when the cap was hit or an error occurred. */
  response: PriestResponse;
  /** Full tool exchange trace accumulated across iterations. */
  exchange: ToolExchangeTurn[];
  /** True when the loop stopped because maxIterations was reached. */
  iterationLimitReached: boolean;
}

/**
 * Generic tool-calling loop: run the request, execute any tool calls through
 * the caller-supplied executor, replay results via toolExchange, and repeat
 * until the model answers without tool calls or the iteration cap is hit.
 *
 * The SDK never chooses or sandboxes tools — policy belongs to the caller via
 * the executor and the onToolCall hook. Tool exchange turns are turn-local
 * and never persisted in sessions.
 */
export async function runWithTools(
  engine: PriestEngine,
  request: PriestRequest,
  executor: ToolExecutor,
  hooks?: ToolLoopHooks,
): Promise<ToolLoopResult> {
  const maxIterations = Math.max(1, hooks?.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const runOptions: RunOptions | undefined = hooks?.signal ? { signal: hooks.signal } : undefined;
  const exchange: ToolExchangeTurn[] = [...(request.toolExchange ?? [])];

  let response: PriestResponse | undefined;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    response = await engine.run({ ...request, toolExchange: exchange }, runOptions);
    if (!response.ok || !response.toolCalls || response.toolCalls.length === 0) {
      return { response, exchange, iterationLimitReached: false };
    }

    exchange.push({ kind: 'assistant', text: response.text, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      const decision = hooks?.onToolCall ? await hooks.onToolCall(call) : { approved: true };
      if (!decision.approved) {
        exchange.push({
          kind: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: `Tool call denied by the caller${decision.reason ? `: ${decision.reason}` : '.'}`,
          isError: true,
        });
        continue;
      }
      const result = await executor(call);
      exchange.push({
        kind: 'tool_result',
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        isError: result.isError,
      });
    }
  }

  // response is always set: maxIterations is clamped to >= 1 above.
  return { response: response!, exchange, iterationLimitReached: true };
}
