import { Profile } from './Profile';

/** Loads a named profile synchronously. */
export interface ProfileLoader {
  load(name: string): Profile;
}
