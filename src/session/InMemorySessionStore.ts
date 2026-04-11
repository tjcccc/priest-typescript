import { randomUUID } from 'crypto';
import { JSONValue } from '../schema/JSONValue';
import { Session } from './SessionModel';
import { SessionStore } from './SessionStore';

/** In-memory session store. Data is lost when the process exits. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(profileName: string, sessionId?: string, metadata?: Record<string, JSONValue>): Promise<Session> {
    const id = sessionId ?? randomUUID();
    const now = new Date();
    const session = new Session(id, profileName, now, now, [], metadata ?? {});
    this.sessions.set(id, session);
    return session;
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
}
