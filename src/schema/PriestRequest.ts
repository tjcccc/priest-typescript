import { ImageInput } from './ImageInput';
import { JSONValue } from './JSONValue';
import { OutputSpec } from './OutputSpec';
import { PriestConfig } from './PriestConfig';
import { SessionRef } from './SessionRef';
import { ProviderToolDefinition, ToolChoice, ToolDefinition, ToolExchangeTurn } from './ToolTypes';

/** A single engine run request. */
export interface PriestRequest {
  /** Provider and model configuration. */
  config: PriestConfig;
  /** The user's prompt. Becomes the content of the final user message. */
  prompt: string;
  /** Profile name to load. Defaults to 'default'. */
  profile?: string;
  /** Session reference. If undefined, no session is created or continued. */
  session?: SessionRef;
  /**
   * App-layer strings injected at the top of the system prompt.
   * Raw, passed through untouched. Use for runtime policy: current date, environment name, guardrails.
   */
  context?: string[];
  /** Dynamic memory entries. Deduped against profile memories and each other. Subject to tail-trim. */
  memory?: string[];
  /** Strings appended to the user turn after the prompt, joined with \n\n. */
  userContext?: string[];
  /** Output format hints. */
  output?: OutputSpec;
  /** Arbitrary caller metadata. Echoed unchanged into PriestResponse.metadata. */
  metadata?: Record<string, JSONValue>;
  /** Tools the model may call. The caller executes them; the SDK only transports. */
  tools?: ToolDefinition[];
  /** Tools the model provider executes itself. They do not enter the caller's tool loop. */
  providerTools?: ProviderToolDefinition[];
  /** Tool selection behavior. Only meaningful when tools is non-empty. */
  toolChoice?: ToolChoice;
  /**
   * Tool loop history for the CURRENT user turn, appended after the user message.
   * Never persisted in sessions — replayed by the caller on each loop iteration.
   */
  toolExchange?: ToolExchangeTurn[];
  /** Images attached to the user turn. Not persisted in sessions. */
  images?: ImageInput[];
}
