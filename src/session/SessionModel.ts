import { JSONValue } from '../schema/JSONValue';

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  role: TurnRole;
  content: string;
  timestamp: Date;
}

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
}
