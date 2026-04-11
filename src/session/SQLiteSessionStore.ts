import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { JSONValue } from '../schema/JSONValue';
import { Session, Turn, TurnRole } from './SessionModel';
import { SessionStore } from './SessionStore';

// Timestamp format constants — must match spec exactly
const WRITE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function dtToStr(date: Date): string {
  // Format: YYYY-MM-DDTHH:MM:SS.ffffff+00:00
  const iso = date.toISOString(); // e.g. 2024-01-15T12:34:56.789Z
  const base = iso.replace('Z', '');
  // Pad microseconds: JS Date only has millisecond precision, pad to 6 digits
  const dotIdx = base.lastIndexOf('.');
  const ms = base.slice(dotIdx + 1); // '789'
  const paddedMs = ms.padEnd(6, '0'); // '789000'
  return base.slice(0, dotIdx + 1) + paddedMs + '+00:00';
}

function strToDt(s: string): Date {
  // Lenient read per spec — tolerate missing microseconds and tz variants
  if (!WRITE_FORMAT_RE.test(s)) return new Date();
  // Normalize to ISO format for Date parsing
  const normalized = s
    .replace('+00:00', 'Z')
    .replace(/(\.\d{1,6})Z/, (_, frac) => frac.slice(0, 4) + 'Z'); // trim to ms
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? new Date() : d;
}

/**
 * SQLite-backed session store.
 *
 * Uses the canonical DDL and timestamp format from spec/behavior/session-lifecycle.md
 * for cross-implementation interoperability with other priest SDKs.
 */
export class SQLiteSessionStore implements SessionStore {
  private db?: Database.Database;

  constructor(private readonly path: string) {}

  open(): void {
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        metadata     TEXT NOT NULL DEFAULT '{}'
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      )
    `);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  async create(profileName: string, sessionId?: string, metadata?: Record<string, JSONValue>): Promise<Session> {
    const db = this.requireDb();
    const id = sessionId ?? randomUUID();
    const now = new Date();
    const metaJSON = JSON.stringify(metadata ?? {});
    db.prepare(
      'INSERT INTO sessions (id, profile_name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(id, profileName, dtToStr(now), dtToStr(now), metaJSON);
    return new Session(id, profileName, now, now, [], metadata ?? {});
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const db = this.requireDb();
    const row = db.prepare(
      'SELECT id, profile_name, created_at, updated_at, metadata FROM sessions WHERE id = ?'
    ).get(sessionId) as { id: string; profile_name: string; created_at: string; updated_at: string; metadata: string } | undefined;

    if (!row) return undefined;

    const meta = JSON.parse(row.metadata) as Record<string, JSONValue>;
    const turns = this.loadTurns(db, row.id);
    return new Session(row.id, row.profile_name, strToDt(row.created_at), strToDt(row.updated_at), turns, meta);
  }

  async save(session: Session): Promise<void> {
    const db = this.requireDb();
    const metaJSON = JSON.stringify(session.metadata);
    db.prepare('UPDATE sessions SET updated_at = ?, metadata = ? WHERE id = ?')
      .run(dtToStr(session.updatedAt), metaJSON, session.id);
    db.prepare('DELETE FROM turns WHERE session_id = ?').run(session.id);
    const insertTurn = db.prepare(
      'INSERT INTO turns (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
    );
    for (const turn of session.turns) {
      insertTurn.run(session.id, turn.role, turn.content, dtToStr(turn.timestamp));
    }
  }

  private loadTurns(db: Database.Database, sessionId: string): Turn[] {
    const rows = db.prepare(
      'SELECT role, content, timestamp FROM turns WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId) as { role: string; content: string; timestamp: string }[];
    return rows.map(r => ({
      role: r.role as TurnRole,
      content: r.content,
      timestamp: strToDt(r.timestamp),
    }));
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('SQLiteSessionStore is not open. Call open() first.');
    return this.db;
  }
}
