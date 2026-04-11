import { describe, expect, it } from 'vitest';
import { PriestEngine } from '../src/engine/PriestEngine';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { ProfileLoader } from '../src/profile/ProfileLoader';
import { InMemorySessionStore } from '../src/session/InMemorySessionStore';
import { MockAdapter } from './MockAdapter';

const config = { provider: 'mock', model: 'test-model' };

class StaticProfileLoader implements ProfileLoader {
  load(_name: string) { return DEFAULT_PROFILE; }
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('PriestEngine.stream', () => {
  it('yields chunks from the adapter', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, {
      mock: new MockAdapter('hello world'),
    });
    const chunks = await collect(engine.stream({ config, prompt: 'Hi' }));
    expect(chunks).toEqual(['hello', 'world']);
  });

  it('throws for unregistered provider', async () => {
    const engine = new PriestEngine(new StaticProfileLoader());
    await expect(collect(engine.stream({ config: { provider: 'nope', model: 'x' }, prompt: 'Hi' })))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_REGISTERED' });
  });

  it('saves session after stream completes', async () => {
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, {
      mock: new MockAdapter('hello world'),
    });
    const chunks = await collect(engine.stream({ config, prompt: 'Hello', session: { id: 'sess1' } }));
    expect(chunks.length).toBeGreaterThan(0);

    const saved = await store.get('sess1');
    expect(saved?.turns).toHaveLength(2);
    expect(saved?.turns[0].role).toBe('user');
    expect(saved?.turns[0].content).toBe('Hello');
    expect(saved?.turns[1].role).toBe('assistant');
    // joined chunks — MockAdapter splits on spaces, so 'hello world' → ['hello', 'world']
    expect(saved?.turns[1].content).toBe(chunks.join(''));
  });

  it('continues a session across stream calls', async () => {
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, {
      mock: new MockAdapter('a b'),
    });
    await collect(engine.stream({ config, prompt: 'First', session: { id: 'sess1' } }));
    await collect(engine.stream({ config, prompt: 'Second', session: { id: 'sess1' } }));

    const saved = await store.get('sess1');
    expect(saved?.turns).toHaveLength(4); // 2 turns per call
  });
});
