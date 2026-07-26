import { JSONValue } from './JSONValue';

/** Provider-neutral reasoning effort. Support is provider- and model-specific. */
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** Optional reasoning request. Omitted fields preserve provider/model defaults. */
export interface ReasoningConfig {
  /** Request provider-native reasoning, or disable it where supported. */
  enabled?: boolean;
  /** Advisory reasoning effort. Providers may reject unsupported values. */
  effort?: ReasoningEffort;
  /** Request the provider's displayable summary, or explicitly request none. */
  summary?: 'none' | 'auto';
}

/**
 * Provider-owned continuation state.
 *
 * The value must be replayed unchanged, only to an adapter that recognizes the
 * format. It must never be interpreted or displayed.
 */
export interface OpaqueReasoningState {
  format: string;
  value: JSONValue;
}

/** Safe reasoning information returned by an adapter. */
export interface ReasoningInfo {
  /** Provider-supplied displayable summary; never private chain-of-thought. */
  summary?: string;
  /** Request-local opaque state needed to continue a tool-use turn. */
  continuation?: OpaqueReasoningState[];
}
