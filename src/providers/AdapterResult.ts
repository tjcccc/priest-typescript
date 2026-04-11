/** Result returned by a provider adapter after a complete (non-streaming) call. */
export interface AdapterResult {
  text: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}
