import { JSONValue } from '../schema/JSONValue';
import { Session } from './SessionModel';

/** Protocol for session persistence backends. */
export interface SessionStore {
  /** Create a new session. sessionId is used as-is if provided; otherwise a UUID is generated. */
  create(profileName: string, sessionId?: string, metadata?: Record<string, JSONValue>): Promise<Session>;
  /** Retrieve a session by ID. Returns undefined if not found. */
  get(sessionId: string): Promise<Session | undefined>;
  /** Persist a session (turns + metadata + updatedAt). */
  save(session: Session): Promise<void>;
}
