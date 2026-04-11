import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  let dbPath: string;
  let store: SQLiteSessionStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `priest_test_${Date.now()}.db`);
    store = new SQLiteSessionStore(dbPath);
    store.open();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch {}
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

  it('persists turns after save', async () => {
    const session = await store.create('default', 's1');
    session.appendTurn('user', 'Hello');
    session.appendTurn('assistant', 'Hi');
    await store.save(session);
    const loaded = await store.get('s1');
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.turns[0].role).toBe('user');
    expect(loaded?.turns[0].content).toBe('Hello');
    expect(loaded?.turns[1].role).toBe('assistant');
  });

  it('returns turns in insertion order', async () => {
    const session = await store.create('default', 's1');
    for (let i = 0; i < 5; i++) session.appendTurn('user', `msg${i}`);
    await store.save(session);
    const loaded = await store.get('s1');
    expect(loaded?.turns.map(t => t.content)).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
  });
});
