/** Reference to a session to create or continue. */
export interface SessionRef {
  /**
   * Session identifier. When createIfMissing is true, this exact ID is used —
   * session creation is idempotent on the same ID.
   */
  id: string;
  /**
   * If true, look up the session by ID before creating.
   * If false, always create a new session (ID is ignored for lookup).
   * Defaults to true.
   */
  continueExisting?: boolean;
  /**
   * Only relevant when continueExisting is true.
   * If the session does not exist: true creates it; false throws SESSION_NOT_FOUND.
   * Defaults to true.
   */
  createIfMissing?: boolean;
}
