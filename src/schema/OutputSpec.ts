/** Provider-native output format hint. Currently only 'json' has broad support. */
export type ProviderFormat = 'json';

/** Natural-language format instruction injected into the system prompt. */
export type PromptFormat = 'json' | 'xml' | 'code';

/**
 * Output format hints for a priest request.
 *
 * Both fields are optional and independent. The engine never parses response
 * text; PriestResponse.text is always the raw string.
 */
export interface OutputSpec {
  /** Activates provider-native structured output (e.g. Ollama format field). */
  providerFormat?: ProviderFormat;
  /** Injects a natural-language format instruction into the system prompt. */
  promptFormat?: PromptFormat;
}
