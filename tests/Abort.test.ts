import { describe, expect, it } from 'vitest';
import { createLinkedAbort } from '../src/util/Abort';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('createLinkedAbort', () => {
  it('aborts on timeout and reports timedOut', async () => {
    const link = createLinkedAbort(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(link.signal.aborted).toBe(true);
    expect(link.timedOut()).toBe(true);
    expect(link.callerAborted()).toBe(false);
    link.dispose();
  });

  it('aborts when the caller signal fires and reports callerAborted', async () => {
    const caller = new AbortController();
    const link = createLinkedAbort(10_000, caller.signal);
    caller.abort();
    await tick();
    expect(link.signal.aborted).toBe(true);
    expect(link.callerAborted()).toBe(true);
    expect(link.timedOut()).toBe(false);
    link.dispose();
  });

  it('honors an already-aborted caller signal', () => {
    const caller = new AbortController();
    caller.abort();
    const link = createLinkedAbort(10_000, caller.signal);
    expect(link.signal.aborted).toBe(true);
    expect(link.callerAborted()).toBe(true);
    link.dispose();
  });

  it('clearTimer stops the timeout but keeps the caller signal wired', async () => {
    const caller = new AbortController();
    const link = createLinkedAbort(1, caller.signal);
    link.clearTimer();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(link.signal.aborted).toBe(false);
    caller.abort();
    await tick();
    expect(link.signal.aborted).toBe(true);
    link.dispose();
  });

  it('dispose unwires the caller signal', async () => {
    const caller = new AbortController();
    const link = createLinkedAbort(10_000, caller.signal);
    link.dispose();
    caller.abort();
    await tick();
    expect(link.signal.aborted).toBe(false);
  });
});
