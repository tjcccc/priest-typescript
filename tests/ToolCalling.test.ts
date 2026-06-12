import { describe, expect, it } from 'vitest';
import { buildMessages } from '../src/engine/ContextBuilder';
import { PriestEngine } from '../src/engine/PriestEngine';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { Profile } from '../src/profile/Profile';
import { ProfileLoader } from '../src/profile/ProfileLoader';
import { ToolCall } from '../src/schema/ToolTypes';
import { InMemorySessionStore } from '../src/session/InMemorySessionStore';
import { ScriptedAdapter } from './MockAdapter';

class StaticProfileLoader implements ProfileLoader {
  constructor(private readonly profile: Profile = DEFAULT_PROFILE) {}
  load(_name: string): Profile { return this.profile; }
}

const config = { provider: 'mock', model: 'test-model' };
const readFileCall: ToolCall = { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } };

describe('tool calling through the engine', () => {
  it('surfaces tool calls on the response with finishedReason tool_calls', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'tool_calls', toolCalls: [readFileCall] },
    ]);
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: adapter });

    const response = await engine.run({
      config,
      prompt: 'Read a.txt',
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    });

    expect(response.ok).toBe(true);
    expect(response.toolCalls).toEqual([readFileCall]);
    expect(response.execution.finishedReason).toBe('tool_calls');
  });

  it('forces finishedReason to tool_calls when the adapter forgot to set it', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'stop', toolCalls: [readFileCall] },
    ]);
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: adapter });
    const response = await engine.run({ config, prompt: 'Read a.txt', tools: [{ name: 'read_file' }] });
    expect(response.execution.finishedReason).toBe('tool_calls');
  });

  it('threads tools and toolChoice into adapter call options', async () => {
    const adapter = new ScriptedAdapter([{ text: 'done', finishReason: 'stop' }]);
    const engine = new PriestEngine(new StaticProfileLoader(), undefined, { mock: adapter });

    await engine.run({
      config,
      prompt: 'Hi',
      tools: [{ name: 'read_file', description: 'Read a file' }],
      toolChoice: 'auto',
    });

    expect(adapter.calls[0].options?.tools).toEqual([{ name: 'read_file', description: 'Read a file' }]);
    expect(adapter.calls[0].options?.toolChoice).toBe('auto');
  });

  it('replays toolExchange turns after the user message', () => {
    const messages = buildMessages({
      profile: DEFAULT_PROFILE,
      session: undefined,
      prompt: 'Read a.txt',
      toolExchange: [
        { kind: 'assistant', text: '', toolCalls: [readFileCall] },
        { kind: 'tool_result', toolCallId: 'call_0', name: 'read_file', content: 'file body' },
      ],
    });

    const tail = messages.slice(-3);
    expect(tail[0]).toMatchObject({ role: 'user' });
    expect(tail[1]).toMatchObject({ role: 'assistant', toolCalls: [readFileCall] });
    expect(tail[2]).toMatchObject({ role: 'tool', toolCallId: 'call_0', name: 'read_file', content: 'file body' });
  });

  it('does not persist session turns while tool calls are pending', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'tool_calls', toolCalls: [readFileCall] },
      { text: 'The file says hello.', finishReason: 'stop' },
    ]);
    const store = new InMemorySessionStore();
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });

    const first = await engine.run({ config, prompt: 'Read a.txt', session: { id: 's1' }, tools: [{ name: 'read_file' }] });
    expect(first.toolCalls).toHaveLength(1);
    const afterFirst = await store.get('s1');
    expect(afterFirst?.turns).toHaveLength(0);

    const second = await engine.run({
      config,
      prompt: 'Read a.txt',
      session: { id: 's1' },
      tools: [{ name: 'read_file' }],
      toolExchange: [
        { kind: 'assistant', toolCalls: [readFileCall] },
        { kind: 'tool_result', toolCallId: 'call_0', name: 'read_file', content: 'hello' },
      ],
    });
    expect(second.text).toBe('The file says hello.');

    const afterSecond = await store.get('s1');
    expect(afterSecond?.turns).toHaveLength(2);
    expect(afterSecond?.turns[0]).toMatchObject({ role: 'user', content: 'Read a.txt' });
    expect(afterSecond?.turns[1]).toMatchObject({ role: 'assistant', content: 'The file says hello.' });
  });
});
