import { describe, expect, it } from 'vitest';
import { PriestEngine } from '../src/engine/PriestEngine';
import { runWithTools } from '../src/engine/ToolLoop';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { Profile } from '../src/profile/Profile';
import { ProfileLoader } from '../src/profile/ProfileLoader';
import { ToolCall } from '../src/schema/ToolTypes';
import { ScriptedAdapter } from './MockAdapter';

class StaticProfileLoader implements ProfileLoader {
  load(_name: string): Profile { return DEFAULT_PROFILE; }
}

const config = { provider: 'mock', model: 'test-model' };
const call: ToolCall = { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } };

function engineWith(adapter: ScriptedAdapter): PriestEngine {
  return new PriestEngine(new StaticProfileLoader(), undefined, { mock: adapter });
}

describe('runWithTools', () => {
  it('executes tool calls and returns the final response with the exchange trace', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'tool_calls', toolCalls: [call] },
      { text: 'The file says hello.', finishReason: 'stop' },
    ]);
    const executed: ToolCall[] = [];

    const result = await runWithTools(
      engineWith(adapter),
      { config, prompt: 'Read a.txt', tools: [{ name: 'read_file' }] },
      async c => { executed.push(c); return { content: 'hello' }; },
    );

    expect(executed).toEqual([call]);
    expect(result.response.text).toBe('The file says hello.');
    expect(result.iterationLimitReached).toBe(false);
    expect(result.exchange).toEqual([
      { kind: 'assistant', text: '', toolCalls: [call] },
      { kind: 'tool_result', toolCallId: 'call_0', name: 'read_file', content: 'hello', isError: undefined },
    ]);
    // Second engine call must have replayed the exchange
    const secondMessages = adapter.calls[1].messages;
    expect(secondMessages.some(m => m.role === 'tool')).toBe(true);
  });

  it('injects a denial result without executing when onToolCall rejects', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'tool_calls', toolCalls: [call] },
      { text: 'Understood, skipping.', finishReason: 'stop' },
    ]);
    let executions = 0;

    const result = await runWithTools(
      engineWith(adapter),
      { config, prompt: 'Read a.txt', tools: [{ name: 'read_file' }] },
      async () => { executions += 1; return { content: 'never' }; },
      { onToolCall: async () => ({ approved: false, reason: 'not allowed' }) },
    );

    expect(executions).toBe(0);
    const denial = result.exchange.find(t => t.kind === 'tool_result');
    expect(denial).toMatchObject({ isError: true });
    expect((denial as { content: string }).content).toContain('not allowed');
    expect(result.response.text).toBe('Understood, skipping.');
  });

  it('stops at maxIterations when the model keeps requesting tools', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'tool_calls', toolCalls: [call] },
    ]);

    const result = await runWithTools(
      engineWith(adapter),
      { config, prompt: 'Loop forever', tools: [{ name: 'read_file' }] },
      async () => ({ content: 'data' }),
      { maxIterations: 3 },
    );

    expect(result.iterationLimitReached).toBe(true);
    expect(adapter.calls).toHaveLength(3);
    expect(result.response.toolCalls).toHaveLength(1);
  });

  it('returns immediately when the first response has no tool calls', async () => {
    const adapter = new ScriptedAdapter([{ text: 'plain answer', finishReason: 'stop' }]);

    const result = await runWithTools(
      engineWith(adapter),
      { config, prompt: 'Hi', tools: [{ name: 'read_file' }] },
      async () => ({ content: 'unused' }),
    );

    expect(result.response.text).toBe('plain answer');
    expect(result.exchange).toEqual([]);
    expect(adapter.calls).toHaveLength(1);
  });

  it('marks executor errors with isError in the exchange', async () => {
    const adapter = new ScriptedAdapter([
      { text: '', finishReason: 'tool_calls', toolCalls: [call] },
      { text: 'Could not read the file.', finishReason: 'stop' },
    ]);

    const result = await runWithTools(
      engineWith(adapter),
      { config, prompt: 'Read a.txt', tools: [{ name: 'read_file' }] },
      async () => ({ content: 'ENOENT', isError: true }),
    );

    expect(result.exchange.find(t => t.kind === 'tool_result')).toMatchObject({ isError: true, content: 'ENOENT' });
  });
});
