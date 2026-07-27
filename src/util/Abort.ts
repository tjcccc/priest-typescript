/**
 * Combine an optional caller signal with a timeout into one AbortController.
 *
 * Implemented without AbortSignal.any so timeout attribution and listener
 * cleanup remain explicit.
 *
 * clearTimer() stops the timeout while keeping the caller signal wired — use
 * it once response headers arrive so long streams aren't killed by the
 * connect timeout but remain cancellable. dispose() removes everything; call
 * it when the request fully settles.
 */
export interface LinkedAbort {
  signal: AbortSignal;
  /** True when the abort was caused by the timeout rather than the caller. */
  timedOut: () => boolean;
  /** True when the abort was caused by the caller's signal. */
  callerAborted: () => boolean;
  clearTimer: () => void;
  dispose: () => void;
}

export function createLinkedAbort(timeoutMs: number, signal?: AbortSignal): LinkedAbort {
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    callerAborted: () => callerAborted,
    clearTimer: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
