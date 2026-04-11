/** A loaded priest profile. */
export interface Profile {
  name: string;
  /** Core identity/persona description. */
  identity: string;
  /** Behavioral rules. */
  rules: string;
  /** Optional extra system content. */
  custom?: string;
  /** Memory strings injected under the memories header. */
  memories: string[];
}
