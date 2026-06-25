import { Message } from '../providers/ProviderAdapter';
import { Turn } from '../session/SessionModel';

/**
 * Conversation compaction primitives.
 *
 * Long sessions replay their full turn history on every call (see ContextBuilder),
 * so input cost grows linearly per turn and quadratically over a session. Compaction
 * folds the older turns into a running summary and replays only a recent tail,
 * bounding the replayed history. It is non-destructive: raw turns stay in the store;
 * only the *replayed view* shrinks. The summary lives in session metadata.
 *
 * Token accounting uses the provider's reported input usage from the previous turn
 * (no tokenizer dependency); the crossing turn overshoots by one, then compaction
 * applies before the next turn.
 */

/** Compact when the previous turn's input usage exceeds this fraction of the budget. */
export const COMPACTION_TRIGGER_RATIO = 0.8;
/** Most-recent turns kept verbatim; older turns fold into the summary. */
export const DEFAULT_COMPACTION_KEEP_TURNS = 6;
/** Output cap for the summary-generation call (keeps the summary itself bounded). */
export const SUMMARY_MAX_OUTPUT_TOKENS = 1024;

export interface CompactionPlan {
  /** Turns to fold into the summary this round (after what's already summarized, before the kept tail). */
  toSummarize: Turn[];
  /** Index into session.turns the new summary will cover up to. */
  summarizedThrough: number;
}

/** Whether the previous turn's input size warrants compaction. Off when no budget is set. */
export function shouldCompact(lastInputTokens: number | undefined, maxContextTokens: number | undefined): boolean {
  if (!maxContextTokens || maxContextTokens <= 0) return false;
  if (lastInputTokens === undefined) return false;
  return lastInputTokens > maxContextTokens * COMPACTION_TRIGGER_RATIO;
}

/**
 * Plan a compaction round: fold every turn after what's already summarized and
 * before the kept tail. Returns undefined when there is nothing new to fold
 * (history still fits within the kept tail), which makes repeated calls safe.
 */
export function planCompaction(
  turns: Turn[],
  alreadySummarizedThrough: number,
  keepTurns: number,
): CompactionPlan | undefined {
  const tailStart = Math.max(0, turns.length - Math.max(0, keepTurns));
  if (tailStart <= alreadySummarizedThrough) return undefined;
  return {
    toSummarize: turns.slice(alreadySummarizedThrough, tailStart),
    summarizedThrough: tailStart,
  };
}

const SUMMARY_SYSTEM = [
  'You compress prior conversation into a compact running summary so the assistant can continue without the full transcript.',
  "Preserve the user's goals and constraints, decisions made, facts established within the conversation, and open or unresolved threads.",
  'Durable user facts are stored separately as memory — do not re-list them. Capture the conversation\'s trajectory and the context needed to continue it.',
  'Write a tight synopsis, not a turn-by-turn log. When an earlier summary is provided, merge the new turns into it and return a single updated summary with no preamble.',
].join(' ');

/** Build the messages for the summary-generation call (existing summary + new turns → one updated summary). */
export function buildSummaryMessages(existingSummary: string | undefined, toSummarize: Turn[]): Message[] {
  const transcript = toSummarize.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
  const user = existingSummary && existingSummary.trim()
    ? `Existing summary so far:\n\n${existingSummary.trim()}\n\n---\n\nNew conversation turns to fold in:\n\n${transcript}\n\n---\n\nReturn one updated summary.`
    : `Conversation turns to summarize:\n\n${transcript}\n\n---\n\nReturn the summary.`;
  return [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: user },
  ];
}
