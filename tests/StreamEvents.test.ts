import { describe, expect, it } from 'vitest';
import { PriestEngine } from '../src/engine/PriestEngine';
import { PriestStreamEvent } from '../src/engine/StreamEvents';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { Profile } from '../src/profile/Profile';
import { ProfileLoader } from '../src/profile/ProfileLoader';
import { ToolCall } from '../src/schema/ToolTypes';
import { InMemorySessionStore } from '../src/session/InMemorySessionStore';
import { EventScriptedAdapter, MockAdapter } from './MockAdapter';

class StaticProfileLoader implements ProfileLoader {
  load(_name: string): Profile { return DEFAULT_PROFILE; }
}

const config = { provider: 'mock', model: 'test-model' };
const call: ToolCall = { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } };

async function collect(gen: AsyncGenerator<PriestStreamEvent>): Promise<PriestStreamEvent[]> {
  const events: PriestStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('PriestEngine.streamEvents', () => {
  it('wraps plain stream() as text deltas when the adapter has no streamEvents', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: new MockAdapter('hello world') });
    const events = await collect(engine.streamEvents({ config, prompt: 'Hi' }));

    expect(events.filter(e => e.type === 'text_delta').map(e => (e as { text: string }).text)).toEqual(['hello', 'world']);
    const done = events[events.length - 1];
    expect(done.type).toBe('done');
    expect((done as { response: { text?: string } }).response.text).toBe('helloworld');
  });

  it('passes through adapter events and assembles tool calls in the done response', async () => {
    const adapter = new EventScriptedAdapter([
      { type: 'text_delta', text: 'Let me check. ' },
      { type: 'tool_call_start', index: 0, id: 'call_0', name: 'read_file' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":"a.txt"}' },
      { type: 'tool_call_end', index: 0, toolCall: call },
      { type: 'usage', inputTokens: 12, outputTokens: 7 },
      { type: 'finish', finishReason: 'tool_calls' },
    ]);
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: adapter });
    const events = await collect(engine.streamEvents({ config, prompt: 'Read a.txt', tools: [{ name: 'read_file' }] }));

    const types = events.map(e => e.type);
    expect(types).toEqual(['text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_end', 'usage', 'done']);

    const done = events[events.length - 1] as Extract<PriestStreamEvent, { type: 'done' }>;
    expect(done.response.toolCalls).toEqual([call]);
    expect(done.response.execution.finishedReason).toBe('tool_calls');
    expect(done.response.usage).toMatchObject({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  });

  it('passes through safe reasoning summaries and includes reasoning usage/state in done', async () => {
    const reasoning = {
      summary: 'Checked the options.',
      continuation: [{
        format: 'test.opaque.v1',
        value: { token: 'opaque' },
      }],
    };
    const adapter = new EventScriptedAdapter([
      { type: 'reasoning_summary_delta', text: 'Checked the options.' },
      { type: 'tool_call_start', index: 0, id: 'call_0', name: 'read_file' },
      { type: 'tool_call_end', index: 0, toolCall: call },
      { type: 'usage', inputTokens: 20, outputTokens: 10, reasoningTokens: 6 },
      { type: 'finish', finishReason: 'tool_calls', reasoning },
    ]);
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: adapter });
    const events = await collect(engine.streamEvents({
      config,
      prompt: 'Read a.txt',
      tools: [{ name: 'read_file' }],
    }));

    expect(events[0]).toEqual({
      type: 'reasoning_summary_delta',
      text: 'Checked the options.',
    });
    const done = events[events.length - 1] as Extract<PriestStreamEvent, { type: 'done' }>;
    expect(done.response.reasoning).toEqual(reasoning);
    expect(done.response.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 6,
      totalTokens: 30,
    });
  });

  it('does not persist the session when the stream ends in tool calls', async () => {
    const adapter = new EventScriptedAdapter([
      { type: 'tool_call_start', index: 0, id: 'call_0', name: 'read_file' },
      { type: 'tool_call_end', index: 0, toolCall: call },
      { type: 'finish', finishReason: 'tool_calls' },
    ]);
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });
    await collect(engine.streamEvents({ config, prompt: 'Read a.txt', session: { id: 's1' }, tools: [{ name: 'read_file' }] }));

    const session = await store.get('s1');
    expect(session?.turns).toHaveLength(0);
  });

  it('persists the session after a plain text stream', async () => {
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: new MockAdapter('final answer') });
    await collect(engine.streamEvents({ config, prompt: 'Hi', session: { id: 's2' } }));

    const session = await store.get('s2');
    expect(session?.turns).toHaveLength(2);
    expect(session?.turns[1].role).toBe('assistant');
  });

  it('surfaces provider errors in done.response.error instead of throwing', async () => {
    const { PriestError } = await import('../src/errors/PriestError');
    const failing = {
      complete: async () => { throw PriestError.providerError('mock', 'boom'); },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<string, void, unknown> { throw PriestError.providerError('mock', 'boom'); },
    };
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: failing });
    const events = await collect(engine.streamEvents({ config, prompt: 'Hi' }));

    const done = events[events.length - 1] as Extract<PriestStreamEvent, { type: 'done' }>;
    expect(done.response.ok).toBe(false);
    expect(done.response.error?.code).toBe('PROVIDER_ERROR');
  });

  it('keeps stream() back-compat: yields text and throws on provider error', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: new MockAdapter('a b') });
    const chunks: string[] = [];
    for await (const chunk of engine.stream({ config, prompt: 'Hi' })) chunks.push(chunk);
    expect(chunks).toEqual(['a', 'b']);
  });
});
