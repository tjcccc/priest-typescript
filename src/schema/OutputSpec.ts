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
  /**
   * JSON Schema for structured output.
   * OpenAI-compat: maps to response_format={type:"json_schema",...}.
   * Ollama (v0.5+): maps to format:<schema_dict>.
   * Anthropic: schema description injected into system message (no native support).
   * When set, takes precedence over providerFormat for the schema-capable path.
   * If promptFormat is also set, both instructions will appear — prefer using one or the other.
   */
  jsonSchema?: Record<string, unknown>;
  /** Schema name passed to OpenAI's json_schema.name field. Defaults to "response". */
  jsonSchemaName?: string;
  /**
   * Maps to OpenAI's json_schema.strict. Requires every property in required and
   * additionalProperties:false. Most user schemas won't satisfy this. Defaults to false.
   */
  jsonSchemaStrict?: boolean;
}
