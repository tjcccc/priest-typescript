import { describe, expect, it } from 'vitest';
import { PriestEngine } from '../src/engine/PriestEngine';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { Profile } from '../src/profile/Profile';
import { ProfileLoader } from '../src/profile/ProfileLoader';
import { InMemorySessionStore } from '../src/session/InMemorySessionStore';
import { MockAdapter } from './MockAdapter';

class StaticProfileLoader implements ProfileLoader {
  constructor(private readonly profile: Profile = DEFAULT_PROFILE) {}
  load(_name: string): Profile { return this.profile; }
}

const config = { provider: 'mock', model: 'test-model' };

describe('PriestEngine', () => {
  it('specVersion is 2.9.0', () => {
    expect(PriestEngine.specVersion).toBe('2.9.0');
  });

  it('returns ok response for registered provider', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: new MockAdapter() });
    const response = await engine.run({ config, prompt: 'Hello' });
    expect(response.ok).toBe(true);
    expect(response.text).toBe('mock response');
  });

  it('throws for unregistered provider', async () => {
    const engine = new PriestEngine(new StaticProfileLoader());
    await expect(engine.run({ config: { provider: 'unknown', model: 'x' }, prompt: 'Hi' }))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_REGISTERED' });
  });

  it('populates execution info', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: new MockAdapter() });
    const response = await engine.run({ config, prompt: 'Hi' });
    expect(response.execution.provider).toBe('mock');
    expect(response.execution.model).toBe('test-model');
    expect(response.execution.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('echoes metadata unchanged', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: new MockAdapter() });
    const response = await engine.run({ config, prompt: 'Hi', metadata: { tag: 'test' } });
    expect(response.metadata).toEqual({ tag: 'test' });
  });

  it('creates session on first call and continues on second', async () => {
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: new MockAdapter() });

    const r1 = await engine.run({ config, prompt: 'Hello', session: { id: 'sess1' } });
    expect(r1.session?.isNew).toBe(true);
    expect(r1.session?.turnCount).toBe(2); // user + assistant

    const r2 = await engine.run({ config, prompt: 'How are you?', session: { id: 'sess1' } });
    expect(r2.session?.isNew).toBe(false);
    expect(r2.session?.turnCount).toBe(4);
  });

  it('throws SESSION_NOT_FOUND when createIfMissing is false', async () => {
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: new MockAdapter() });
    await expect(engine.run({
      config,
      prompt: 'Hi',
      session: { id: 'missing', continueExisting: true, createIfMissing: false },
    })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('places provider error into response.error and sets ok=false', async () => {
    const { PriestError } = await import('../src/errors/PriestError');
    const failingAdapter = {
      complete: async () => { throw PriestError.providerError('mock', 'network fail'); },
      async *stream() {},
    };
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: failingAdapter });
    const response = await engine.run({ config, prompt: 'Hi' });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('PROVIDER_ERROR');
  });

  it('rejects a provider-executed tool when the adapter does not support it', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: new MockAdapter() });
    const response = await engine.run({
      config,
      prompt: 'Search the web.',
      providerTools: [{ type: 'web_search' }],
    });
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining("Provider tool 'web_search' is not supported"),
    });
  });
});
