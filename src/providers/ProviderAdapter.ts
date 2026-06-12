import { OutputSpec } from '../schema/OutputSpec';
import { PriestConfig } from '../schema/PriestConfig';
import { ToolCall, ToolChoice, ToolDefinition } from '../schema/ToolTypes';
import { AdapterResult } from './AdapterResult';

/**
 * Multimodal content block in OpenAI wire format. The context builder emits
 * this format (images first, text last) and each adapter converts to its
 * provider's native shape — mirrors context_builder.py exactly.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text, or content blocks when the user turn carries images. */
  content: string | ContentBlock[];
  /** Tool calls made by the model. Assistant role only. */
  toolCalls?: ToolCall[];
  /** Id of the tool call this message answers. Tool role only. */
  toolCallId?: string;
  /** Tool name. Tool role only. */
  name?: string;
}

/** Per-call options threaded from the engine into adapters. */
export interface AdapterCallOptions {
  /** Caller cancellation. Combined with the adapter's own timeout controller. */
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

/**
 * Structured streaming events emitted by adapters that implement streamEvents.
 * Adapters without native event streaming are wrapped by the engine: every
 * stream() chunk becomes a text_delta and a final finish event is synthesized.
 */
export type AdapterStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id?: string; name?: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'tool_call_end'; index: number; toolCall: ToolCall }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'finish'; finishReason?: string };

/** Interface that all provider adapters must implement. */
export interface ProviderAdapter {
  /** Execute a request and return the full response. */
  complete(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult>;
  /** Yield text chunks as they arrive. */
  stream(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<string, void, unknown>;
  /**
   * Optional. Yield structured streaming events including tool-call deltas
   * and usage. When absent, the engine falls back to wrapping stream().
   */
  streamEvents?(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<AdapterStreamEvent, void, unknown>;
}
