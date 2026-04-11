/** All priest error codes. Values match the spec-defined strings. */
export type PriestErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_STORE_ERROR'
  | 'PROVIDER_NOT_REGISTERED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'REQUEST_INVALID'
  | 'INTERNAL_ERROR';

/**
 * Base error class for all priest errors.
 *
 * Two errors are always thrown and never placed into PriestResponse.error:
 * - PROVIDER_NOT_REGISTERED — no adapter means no response can be constructed.
 * - SESSION_NOT_FOUND — the caller explicitly opted out of session creation.
 *
 * All other provider errors are caught and placed into PriestResponse.error.
 */
export class PriestError extends Error {
  readonly code: PriestErrorCode;
  readonly details: Record<string, string>;

  constructor(code: PriestErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'PriestError';
    this.code = code;
    this.details = details;
  }

  static profileNotFound(name: string): PriestError {
    return new PriestError('PROFILE_NOT_FOUND', `Profile '${name}' not found`, { profile: name });
  }

  static sessionNotFound(sessionId: string): PriestError {
    return new PriestError('SESSION_NOT_FOUND', `Session '${sessionId}' not found`, { session_id: sessionId });
  }

  static providerNotRegistered(provider: string): PriestError {
    return new PriestError('PROVIDER_NOT_REGISTERED', `Provider '${provider}' is not registered`, { provider });
  }

  static providerTimeout(provider: string, timeout: number): PriestError {
    return new PriestError('PROVIDER_TIMEOUT', `Provider '${provider}' timed out after ${timeout}s`, { provider, timeout: String(timeout) });
  }

  static providerError(provider: string, message: string): PriestError {
    return new PriestError('PROVIDER_ERROR', `Provider '${provider}' error: ${message}`, { provider });
  }

  static providerRateLimited(provider: string, retryAfter?: number): PriestError {
    const msg = retryAfter !== undefined
      ? `Provider '${provider}' rate limited — retry after ${retryAfter}s`
      : `Provider '${provider}' rate limited`;
    const details: Record<string, string> = { provider };
    if (retryAfter !== undefined) details.retry_after = String(retryAfter);
    return new PriestError('PROVIDER_RATE_LIMITED', msg, details);
  }
}
