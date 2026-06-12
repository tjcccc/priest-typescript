import { JSONValue } from '../schema/JSONValue';

/**
 * Parse raw tool-call argument JSON. Per spec (behavior/tool-calling.md),
 * unparseable or non-object JSON becomes {} — never an exception. Exposed for
 * custom adapter implementations.
 */
export function parseToolArguments(raw: string): Record<string, JSONValue> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as JSONValue;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, JSONValue>;
    }
  } catch {
    // fall through
  }
  return {};
}
