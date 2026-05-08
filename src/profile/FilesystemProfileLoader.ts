import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PROFILE } from './DefaultProfile';
import { Profile } from './Profile';
import { ProfileLoader } from './ProfileLoader';

interface CacheEntry {
  mtime: number;
  profile: Profile;
}

export interface FilesystemProfileLoaderOptions {
  /**
   * Load memories from the profile file. Set false when the host app owns
   * memory selection and passes selected memory through PriestRequest.memory.
   */
  includeMemories?: boolean;
}

/**
 * Loads profiles from JSON files in a directory.
 *
 * File layout: <baseDir>/<name>.json
 * Caches loaded profiles per instance; invalidates when the file's mtime changes.
 * Falls back to the built-in default profile when the file is not found.
 */
export class FilesystemProfileLoader implements ProfileLoader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly includeMemories: boolean;

  constructor(private readonly baseDir: string, options: FilesystemProfileLoaderOptions = {}) {
    this.includeMemories = options.includeMemories ?? true;
  }

  load(name: string): Profile {
    const filePath = path.join(this.baseDir, `${name}.json`);
    try {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;
      const cached = this.cache.get(name);
      if (cached && cached.mtime === mtime) return cached.profile;

      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<Profile>;
      const profile: Profile = {
        name,
        identity: data.identity ?? '',
        rules: data.rules ?? '',
        custom: data.custom,
        memories: this.includeMemories ? data.memories ?? [] : [],
      };
      this.cache.set(name, { mtime, profile });
      return profile;
    } catch {
      if (name === 'default') return { ...DEFAULT_PROFILE };
      throw new Error(`Profile '${name}' not found at ${filePath}`);
    }
  }
}
