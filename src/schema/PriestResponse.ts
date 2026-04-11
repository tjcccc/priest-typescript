import { JSONValue } from './JSONValue';

export type FinishedReason = 'stop' | 'length' | 'error' | 'unknown';

/** Execution metadata for a completed run. */
export interface ExecutionInfo {
  provider: string;
  model: string;
  /** Wall-clock time from start to return, in milliseconds. */
  latencyMs?: number;
  profile: string;
  finishedReason?: FinishedReason;
}

/** Token usage reported by the provider. */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  /** inputTokens + outputTokens. Undefined if both are undefined. */
  totalTokens?: number;
  estimatedCostUSD?: number;
}

/** Session state after a run. */
export interface SessionInfo {
  id: string;
  /** True if this run created the session. */
  isNew: boolean;
  /** Total number of turns in the session after this run. */
  turnCount: number;
}

/**
 * Structured error placed into PriestResponse when a provider call fails.
 * Distinct from thrown PriestError (which is for PROVIDER_NOT_REGISTERED
 * and SESSION_NOT_FOUND — errors where no response can be constructed).
 */
export interface PriestErrorModel {
  code: string;
  message: string;
  details: Record<string, string>;
}

/** Result of a single engine run. */
export interface PriestResponse {
  /** Raw text returned by the provider. Undefined on error or no content. */
  text?: string;
  execution: ExecutionInfo;
  /** Token usage. Undefined if the provider did not report usage data. */
  usage?: UsageInfo;
  /** Session state after this run. Undefined if no session was used. */
  session?: SessionInfo;
  /** Error details if the run failed. Undefined on success. */
  error?: PriestErrorModel;
  /** Caller metadata echoed from PriestRequest.metadata unchanged. */
  metadata: Record<string, JSONValue>;
  /** True when error is undefined. */
  ok: boolean;
}
