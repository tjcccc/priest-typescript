import { JSONValue } from '../schema/JSONValue';

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  role: TurnRole;
  content: string;
  timestamp: Date;
}

/**
 * Conversation-compaction state, persisted inside session metadata under
 * COMPACTION_METADATA_KEY. Kept in metadata (not a dedicated column) so the
 * SQLite schema stays unchanged and other priest SDKs round-trip it untouched.
 */
export interface CompactionState {
  /** Running synopsis covering session.turns[0 .. summarizedThrough). */
  summary?: string;
  /** Number of leading turns folded into `summary` (index into session.turns). */
  summarizedThrough?: number;
  /** Provider-reported input tokens of the most recent measured (chat) turn — the compaction trigger signal. */
  lastInputTokens?: number;
  /** ISO timestamp of the last compaction-state update. */
  updatedAt?: string;
}

export const COMPACTION_METADATA_KEY = '__compaction';

/** A conversation session. Mutated in place during a run. */
export class Session {
  readonly id: string;
  readonly profileName: string;
  readonly createdAt: Date;
  updatedAt: Date;
  turns: Turn[];
  metadata: Record<string, JSONValue>;

  constructor(
    id: string,
    profileName: string,
    createdAt: Date,
    updatedAt: Date,
    turns: Turn[] = [],
    metadata: Record<string, JSONValue> = {},
  ) {
    this.id = id;
    this.profileName = profileName;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.turns = turns;
    this.metadata = metadata;
  }

  appendTurn(role: TurnRole, content: string): void {
    this.turns.push({ role, content, timestamp: new Date() });
    this.updatedAt = new Date();
  }

  /** Read the compaction state from metadata. Returns an empty object when unset. */
  getCompaction(): CompactionState {
    const raw = this.metadata[COMPACTION_METADATA_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as CompactionState) : {};
  }

  private setCompaction(state: CompactionState): void {
    this.metadata[COMPACTION_METADATA_KEY] = state as unknown as JSONValue;
    this.updatedAt = new Date();
  }

  /** Record the most recent turn's provider-reported input size (the compaction trigger signal). */
  recordInputTokens(tokens: number | undefined): void {
    if (tokens === undefined) return;
    this.setCompaction({ ...this.getCompaction(), lastInputTokens: tokens });
  }

  /** Fold turns[0 .. summarizedThrough) into `summary`; raw turns are left intact. */
  applyCompaction(summary: string, summarizedThrough: number): void {
    this.setCompaction({
      ...this.getCompaction(),
      summary,
      summarizedThrough,
      updatedAt: new Date().toISOString(),
    });
  }
}
