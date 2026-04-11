/**
 * Type-safe representation of any JSON value.
 *
 * Used for PriestConfig.providerOptions, PriestRequest.metadata, and
 * PriestResponse.metadata — fields that are dict[str, Any] in Python.
 */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };
