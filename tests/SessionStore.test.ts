import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../src/session/InMemorySessionStore';
import { SQLiteSessionStore } from '../src/session/SQLiteSessionStore';

// ── InMemorySessionStore ──────────────────────────────────────────────────────

describe('InMemorySessionStore', () => {
  it('creates and retrieves a session', async () => {
    const store = new InMemorySessionStore();
    const session = await store.create('default', 's1');
    expect(session.id).toBe('s1');
    const loaded = await store.get('s1');
    expect(loaded?.id).toBe('s1');
    expect(loaded?.profileName).toBe('default');
  });

  it('returns undefined for missing session', async () => {
    const store = new InMemorySessionStore();
    expect(await store.get('nope')).toBeUndefined();
  });

  it('persists turns after save', async () => {
    const store = new InMemorySessionStore();
    const session = await store.create('default', 's1');
    session.appendTurn('user', 'Hello');
    session.appendTurn('assistant', 'Hi');
    await store.save(session);
    const loaded = await store.get('s1');
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.turns[0].content).toBe('Hello');
    expect(loaded?.turns[1].content).toBe('Hi');
  });

  it('generates a UUID when sessionId is omitted', async () => {
    const store = new InMemorySessionStore();
    const session = await store.create('default');
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── SQLiteSessionStore ────────────────────────────────────────────────────────

describe('SQLiteSessionStore', () => {
  let tempDir: string;
  let dbPath: string;
  let store: SQLiteSessionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priest-session-store-'));
    dbPath = path.join(tempDir, 'sessions.db');
    store = new SQLiteSessionStore(dbPath);
    store.open();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and retrieves a session', async () => {
    const session = await store.create('default', 's1');
    expect(session.id).toBe('s1');
    const loaded = await store.get('s1');
    expect(loaded?.id).toBe('s1');
    expect(loaded?.profileName).toBe('default');
  });

  it('returns undefined for missing session', async () => {
    expect(await store.get('missing')).toBeUndefined();
  });

  it('persists multiple ordered exchanges across close, reopen, and update', async () => {
    const session = await store.create('default', 's1');
    session.appendTurn('user', 'Question 1');
    session.appendTurn('assistant', 'Answer 1');
    session.appendTurn('user', 'Question 2');
    session.appendTurn('assistant', 'Answer 2');
    await store.save(session);

    store.close();
    store.open();

    const reopened = await store.get('s1');
    expect(reopened?.turns.map(turn => [turn.role, turn.content])).toEqual([
      ['user', 'Question 1'],
      ['assistant', 'Answer 1'],
      ['user', 'Question 2'],
      ['assistant', 'Answer 2'],
    ]);

    reopened?.appendTurn('user', 'Question 3');
    reopened?.appendTurn('assistant', 'Answer 3');
    await store.save(reopened!);

    store.close();
    store.open();

    const updated = await store.get('s1');
    expect(updated?.turns.map(turn => [turn.role, turn.content])).toEqual([
      ['user', 'Question 1'],
      ['assistant', 'Answer 1'],
      ['user', 'Question 2'],
      ['assistant', 'Answer 2'],
      ['user', 'Question 3'],
      ['assistant', 'Answer 3'],
    ]);
  });

  it('opens and updates an existing canonical database without migration', async () => {
    store.close();
    fs.rmSync(dbPath, { force: true });

    const existing = new Database(dbPath);
    existing.exec(`
      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        metadata     TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      );
    `);
    existing.prepare(
      'INSERT INTO sessions (id, profile_name, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'existing-session',
      'default',
      '2024-01-15T12:34:56.123456+00:00',
      '2024-01-15T12:35:00.654321+00:00',
      '{"origin":"another-sdk"}',
    );
    const insertTurn = existing.prepare(
      'INSERT INTO turns (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
    );
    insertTurn.run('existing-session', 'user', 'Existing question', '2024-01-15T12:34:57.111111+00:00');
    insertTurn.run('existing-session', 'assistant', 'Existing answer', '2024-01-15T12:35:00.222222+00:00');
    existing.close();

    store.open();
    const loaded = await store.get('existing-session');
    expect(loaded?.metadata).toEqual({ origin: 'another-sdk' });
    expect(loaded?.turns.map(turn => [turn.role, turn.content])).toEqual([
      ['user', 'Existing question'],
      ['assistant', 'Existing answer'],
    ]);

    loaded?.appendTurn('user', 'New question');
    loaded?.appendTurn('assistant', 'New answer');
    await store.save(loaded!);
    store.close();
    store.open();

    const updated = await store.get('existing-session');
    expect(updated?.turns.map(turn => turn.content)).toEqual([
      'Existing question',
      'Existing answer',
      'New question',
      'New answer',
    ]);

    store.close();
    const verified = new Database(dbPath, { readonly: true });
    expect(verified.pragma('integrity_check', { simple: true })).toBe('ok');
    const timestamps = verified.prepare(`
      SELECT created_at AS timestamp FROM sessions
      UNION ALL SELECT updated_at FROM sessions
      UNION ALL SELECT timestamp FROM turns
    `).all() as { timestamp: string }[];
    expect(timestamps.every(row => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/.test(row.timestamp))).toBe(true);
    verified.close();
  });

  it('closes and reopens cleanly in WAL mode', async () => {
    const session = await store.create('default', 'wal-session');
    session.appendTurn('user', 'Before close');
    session.appendTurn('assistant', 'Persisted');
    await store.save(session);

    store.close();
    expect(() => store.close()).not.toThrow();
    store.open();
    expect((await store.get('wal-session'))?.turns.map(turn => turn.content)).toEqual([
      'Before close',
      'Persisted',
    ]);
    store.close();

    const verified = new Database(dbPath);
    expect(verified.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(verified.pragma('integrity_check', { simple: true })).toBe('ok');
    verified.close();
  });
});
