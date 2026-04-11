import { Profile } from './Profile';

/**
 * Built-in fallback profile.
 * Content must match spec/behavior/profile-loading.md exactly.
 */
export const DEFAULT_PROFILE: Profile = {
  name: 'default',
  identity: 'You are a helpful, thoughtful assistant.\n',
  rules: 'Be honest. Do not make things up.\nBe concise unless the user asks for depth.\n',
  memories: [],
};
