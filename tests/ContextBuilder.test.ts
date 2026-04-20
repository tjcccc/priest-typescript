import { describe, expect, it } from 'vitest';
import { buildMessages } from '../src/engine/ContextBuilder';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { Profile } from '../src/profile/Profile';

const baseProfile: Profile = {
  name: 'test',
  identity: 'You are a test assistant.',
  rules: 'Be helpful.',
  memories: [],
};

describe('ContextBuilder', () => {
  it('produces a system message and a user message for a basic request', () => {
    const msgs = buildMessages({ profile: baseProfile, session: undefined, prompt: 'Hello' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('Hello');
  });

  it('omits system message when profile has no content', () => {
    const empty: Profile = { name: 'empty', identity: '', rules: '', memories: [] };
    const msgs = buildMessages({ profile: empty, session: undefined, prompt: 'Hi' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });

  it('puts rules before identity in the system message', () => {
    const msgs = buildMessages({ profile: baseProfile, session: undefined, prompt: 'Hi' });
    const system = msgs[0].content;
    expect(system.indexOf('Be helpful.')).toBeLessThan(system.indexOf('You are a test assistant.'));
  });

  it('injects context before rules', () => {
    const msgs = buildMessages({
      profile: baseProfile,
      session: undefined,
      prompt: 'Hi',
      context: ['Today is Monday.'],
    });
    const system = msgs[0].content;
    expect(system.indexOf('Today is Monday.')).toBeLessThan(system.indexOf('Be helpful.'));
  });

  it('appends userContext to the user message with double newline separator', () => {
    const msgs = buildMessages({
      profile: baseProfile,
      session: undefined,
      prompt: 'Summarize this',
      userContext: ['Context: some document'],
    });
    expect(msgs[msgs.length - 1].content).toBe('Summarize this\n\nContext: some document');
  });

  it('uses correct format instruction strings', () => {
    const formats = [
      { fmt: 'json' as const, expected: 'Respond only with valid JSON. No prose, no markdown code fences.' },
      { fmt: 'xml'  as const, expected: 'Respond only with valid XML. No prose, no markdown code fences.' },
      { fmt: 'code' as const, expected: 'Respond only with code. No prose, no markdown code fences around it.' },
    ];
    for (const { fmt, expected } of formats) {
      const msgs = buildMessages({ profile: baseProfile, session: undefined, prompt: 'Hi', outputSpec: { promptFormat: fmt } });
      expect(msgs[0].content).toContain(expected);
    }
  });

  it('renders profile memories block with correct header and single-newline separator', () => {
    const profile: Profile = { ...baseProfile, memories: ['mem1', 'mem2'] };
    const msgs = buildMessages({ profile, session: undefined, prompt: 'Hi' });
    expect(msgs[0].content).toContain('## Loaded Memories\n\nmem1\nmem2');
  });

  it('joins system parts with double newline', () => {
    const profile: Profile = { ...baseProfile, custom: 'Custom section.' };
    const msgs = buildMessages({ profile, session: undefined, prompt: 'Hi' });
    expect(msgs[0].content).toContain('\n\n');
  });

  it('default profile identity and rules match spec', () => {
    expect(DEFAULT_PROFILE.identity).toBe('You are a helpful, thoughtful assistant.\n');
    expect(DEFAULT_PROFILE.rules).toBe('Be honest. Do not make things up.\nBe concise unless the user asks for depth.\n');
  });

  // v2.0.0 — dynamic memory block

  it('renders dynamic memory under ## Memory header', () => {
    const msgs = buildMessages({
      profile: baseProfile,
      session: undefined,
      prompt: 'Hi',
      memory: ['User prefers dark mode.'],
    });
    expect(msgs[0].content).toContain('## Memory\n\nUser prefers dark mode.');
  });

  it('renders profile memories before dynamic memory', () => {
    const profile: Profile = { ...baseProfile, memories: ['Static fact.'] };
    const msgs = buildMessages({
      profile,
      session: undefined,
      prompt: 'Hi',
      memory: ['Dynamic fact.'],
    });
    const system = msgs[0].content;
    expect(system.indexOf('## Loaded Memories')).toBeLessThan(system.indexOf('## Memory'));
  });

  // v2.0.0 — deduplication

  it('drops dynamic memory entry that duplicates a profile memory', () => {
    const profile: Profile = { ...baseProfile, memories: ['Fact A.'] };
    const msgs = buildMessages({
      profile,
      session: undefined,
      prompt: 'Hi',
      memory: ['Fact A.', 'Fact B.'],
    });
    const system = msgs[0].content;
    // 'Fact A.' should appear only once (in Loaded Memories)
    const firstIdx = system.indexOf('Fact A.');
    const secondIdx = system.indexOf('Fact A.', firstIdx + 1);
    expect(secondIdx).toBe(-1);
    expect(system).toContain('Fact B.');
  });

  it('drops duplicate entries within dynamic memory itself', () => {
    const msgs = buildMessages({
      profile: baseProfile,
      session: undefined,
      prompt: 'Hi',
      memory: ['Note X.', 'Note X.'],
    });
    const system = msgs[0].content;
    const firstIdx = system.indexOf('Note X.');
    const secondIdx = system.indexOf('Note X.', firstIdx + 1);
    expect(secondIdx).toBe(-1);
  });

  it('strips whitespace when comparing for dedup', () => {
    const profile: Profile = { ...baseProfile, memories: ['Fact A.'] };
    const msgs = buildMessages({
      profile,
      session: undefined,
      prompt: 'Hi',
      memory: ['  Fact A.  '],
    });
    const system = msgs[0].content;
    // stripped ' Fact A.' should be deduped — no ## Memory block
    expect(system).not.toContain('## Memory');
  });

  // v2.0.0 — trim

  it('trims dynamic memory tail-first when maxSystemChars exceeded', () => {
    const profile: Profile = { ...baseProfile, identity: '', rules: '' };
    const msgs = buildMessages({
      profile,
      session: undefined,
      prompt: 'Hi',
      memory: ['Short.', 'X'.repeat(500)],
      maxSystemChars: 50,
    });
    const system = msgs[0].content;
    // Long entry trimmed first, short one survives
    expect(system).toContain('Short.');
    expect(system).not.toContain('X'.repeat(500));
  });

  it('does not trim when maxSystemChars is not set', () => {
    const profile: Profile = { ...baseProfile, identity: '', rules: '' };
    const msgs = buildMessages({
      profile,
      session: undefined,
      prompt: 'Hi',
      memory: ['A.', 'B.', 'C.'],
    });
    const system = msgs[0].content;
    expect(system).toContain('A.');
    expect(system).toContain('B.');
    expect(system).toContain('C.');
  });
});
