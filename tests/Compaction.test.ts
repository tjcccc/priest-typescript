import { describe, expect, it } from 'vitest';
import { PriestEngine } from '../src/engine/PriestEngine';
import {
  buildSummaryMessages,
  planCompaction,
  shouldCompact,
} from '../src/engine/Compactor';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { Profile } from '../src/profile/Profile';
import { ProfileLoader } from '../src/profile/ProfileLoader';
import { InMemorySessionStore } from '../src/session/InMemorySessionStore';
import { Turn } from '../src/session/SessionModel';
import { AdapterResult } from '../src/providers/AdapterResult';
import { AdapterStreamEvent, Message, ProviderAdapter } from '../src/providers/ProviderAdapter';
import { PriestStreamEvent } from '../src/engine/StreamEvents';

class StaticProfileLoader implements ProfileLoader {
  constructor(private readonly profile: Profile = DEFAULT_PROFILE) {}
  load(_name: string): Profile { return this.profile; }
}

function turn(role: 'user' | 'assistant', content: string): Turn {
  return { role, content, timestamp: new Date() };
}

const SUMMARY_MARKER = 'compress prior conversation';

/**
 * Adapter that reports a fixed input size on chat turns (to drive the
 * compaction trigger) and a short summary on the summarization call, which it
 * recognizes by the Compactor's system prompt. Records every messages array.
 */
class ProgrammableAdapter implements ProviderAdapter {
  readonly calls: Message[][] = [];
  constructor(private readonly inputTokens: number, private readonly summaryText = 'SUMMARY') {}

  private isSummaryCall(messages: Message[]): boolean {
    const sys = messages[0]?.content;
    return typeof sys === 'string' && sys.includes(SUMMARY_MARKER);
  }

  async complete(messages: Message[]): Promise<AdapterResult> {
    this.calls.push(messages);
    const summary = this.isSummaryCall(messages);
    return {
      text: summary ? this.summaryText : 'assistant reply',
      finishReason: 'stop',
      inputTokens: summary ? 5 : this.inputTokens,
      outputTokens: 5,
    };
  }

  async *stream(messages: Message[]): AsyncGenerator<string, void, unknown> {
    for await (const e of this.streamEvents(messages)) {
      if (e.type === 'text_delta') yield e.text;
    }
  }

  async *streamEvents(messages: Message[]): AsyncGenerator<AdapterStreamEvent, void, unknown> {
    this.calls.push(messages);
    yield { type: 'text_delta', text: 'assistant reply' };
    yield { type: 'usage', inputTokens: this.inputTokens, outputTokens: 5 };
    yield { type: 'finish', finishReason: 'stop' };
  }
}

async function drain(gen: AsyncGenerator<PriestStreamEvent, void, unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

describe('Compactor (pure)', () => {
  it('shouldCompact is off without a budget and without a measured turn', () => {
    expect(shouldCompact(10_000, undefined)).toBe(false);
    expect(shouldCompact(10_000, 0)).toBe(false);
    expect(shouldCompact(undefined, 1000)).toBe(false);
  });

  it('shouldCompact fires only above 80% of the budget', () => {
    expect(shouldCompact(799, 1000)).toBe(false);
    expect(shouldCompact(801, 1000)).toBe(true);
  });

  it('planCompaction returns undefined while history fits within the kept tail', () => {
    const turns = [turn('user', 'a'), turn('assistant', 'b')];
    expect(planCompaction(turns, 0, 2)).toBeUndefined();
  });

  it('planCompaction folds turns before the tail and advances the coverage point', () => {
    const turns = [turn('user', 'u1'), turn('assistant', 'a1'), turn('user', 'u2'), turn('assistant', 'a2')];
    const plan = planCompaction(turns, 0, 2);
    expect(plan?.summarizedThrough).toBe(2);
    expect(plan?.toSummarize.map(t => t.content)).toEqual(['u1', 'a1']);
  });

  it('planCompaction is recursive — only folds turns after what is already summarized', () => {
    const turns = [
      turn('user', 'u1'), turn('assistant', 'a1'),
      turn('user', 'u2'), turn('assistant', 'a2'),
      turn('user', 'u3'), turn('assistant', 'a3'),
    ];
    const plan = planCompaction(turns, 2, 2);
    expect(plan?.summarizedThrough).toBe(4);
    expect(plan?.toSummarize.map(t => t.content)).toEqual(['u2', 'a2']);
  });

  it('buildSummaryMessages merges an existing summary and includes the new turns', () => {
    const messages = buildSummaryMessages('prior synopsis', [turn('user', 'hello'), turn('assistant', 'hi there')]);
    expect(messages[0].content).toContain(SUMMARY_MARKER);
    expect(messages[1].content).toContain('prior synopsis');
    expect(messages[1].content).toContain('hello');
    expect(messages[1].content).toContain('hi there');
  });
});

describe('PriestEngine conversation compaction', () => {
  const config = { provider: 'mock', model: 'test-model', maxContextTokens: 100, compactionKeepTurns: 2 };

  it('compacts an over-budget chat session and replays summary + tail (complete path)', async () => {
    const store = new InMemorySessionStore();
    const adapter = new ProgrammableAdapter(200);
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });

    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await engine.run({ config, prompt, session: { id: 's' } });
    }

    const session = await store.get('s');
    expect(session?.getCompaction().summary).toBe('SUMMARY');

    // A summarization call happened (recognized by the Compactor system prompt).
    expect(adapter.calls.some(m => typeof m[0]?.content === 'string' && (m[0].content as string).includes(SUMMARY_MARKER))).toBe(true);

    // The most recent chat turn's messages carry the summary in system and drop the folded-away first turn.
    const lastChat = [...adapter.calls].reverse().find(m => !(typeof m[0]?.content === 'string' && (m[0].content as string).includes(SUMMARY_MARKER)))!;
    expect(lastChat[0].content).toContain('## Conversation so far (summary)');
    expect(lastChat[0].content).toContain('SUMMARY');
    expect(lastChat.some(m => m.content === 'msg1')).toBe(false);
  });

  it('still compacts when tools are offered but never invoked (no toolExchange)', async () => {
    const store = new InMemorySessionStore();
    const adapter = new ProgrammableAdapter(200);
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });
    const tools = [{ name: 'web_search', description: 'search', parameters: { type: 'object' as const } }];

    // Tools are present on every request, but the model never returns toolCalls,
    // so no toolExchange is ever replayed — this is the chat + web_search case.
    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await engine.run({ config, prompt, session: { id: 's' }, tools });
    }

    expect((await store.get('s'))?.getCompaction().summary).toBe('SUMMARY');
  });

  it('does not record the trigger when a tool exchange is replayed', async () => {
    const store = new InMemorySessionStore();
    const adapter = new ProgrammableAdapter(200);
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });
    const toolExchange = [{ kind: 'tool_result' as const, toolCallId: 'c1', name: 'web_search', content: 'big results' }];

    await engine.run({ config, prompt: 'msg1', session: { id: 's' }, toolExchange });
    // Input size from a tool-exchange turn must not seed the trigger.
    expect((await store.get('s'))?.getCompaction().lastInputTokens).toBeUndefined();
  });

  it('compacts over the streaming path too', async () => {
    const store = new InMemorySessionStore();
    const adapter = new ProgrammableAdapter(200);
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });

    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await drain(engine.streamEvents({ config, prompt, session: { id: 's' } }));
    }

    expect((await store.get('s'))?.getCompaction().summary).toBe('SUMMARY');
  });

  it('never compacts when no budget is configured', async () => {
    const store = new InMemorySessionStore();
    const adapter = new ProgrammableAdapter(200);
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });
    const noBudget = { provider: 'mock', model: 'test-model' };

    for (const prompt of ['msg1', 'msg2', 'msg3', 'msg4']) {
      await engine.run({ config: noBudget, prompt, session: { id: 's' } });
    }

    expect((await store.get('s'))?.getCompaction().summary).toBeUndefined();
    expect(adapter.calls.some(m => typeof m[0]?.content === 'string' && (m[0].content as string).includes(SUMMARY_MARKER))).toBe(false);
  });

  it('compactSession folds on demand and reports coverage', async () => {
    const store = new InMemorySessionStore();
    const adapter = new ProgrammableAdapter(10); // small input — no auto-compaction
    const engine = new PriestEngine(new StaticProfileLoader(), store, { mock: adapter });
    const noBudget = { provider: 'mock', model: 'test-model' };

    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await engine.run({ config: noBudget, prompt, session: { id: 's' } });
    }
    expect((await store.get('s'))?.getCompaction().summary).toBeUndefined();

    const result = await engine.compactSession('s', { provider: 'mock', model: 'test-model', compactionKeepTurns: 2 });
    expect(result.compacted).toBe(true);
    expect(result.summarizedThrough).toBe(4); // 6 turns − keep 2
    expect((await store.get('s'))?.getCompaction().summary).toBe('SUMMARY');
  });

  it('compactSession throws for an unknown session', async () => {
    const engine = new PriestEngine(new StaticProfileLoader(), new InMemorySessionStore(), { mock: new ProgrammableAdapter(10) });
    await expect(engine.compactSession('nope', { provider: 'mock', model: 'm' }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});
