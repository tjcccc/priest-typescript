import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PROFILE } from './DefaultProfile';
import { Profile } from './Profile';
import { ProfileLoader } from './ProfileLoader';

/**
 * Loads profiles from JSON files in a directory.
 *
 * File layout: <baseDir>/<name>.json
 * Falls back to the built-in default profile when the file is not found.
 */
export class FilesystemProfileLoader implements ProfileLoader {
  constructor(private readonly baseDir: string) {}

  load(name: string): Profile {
    const filePath = path.join(this.baseDir, `${name}.json`);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<Profile>;
      return {
        name,
        identity: data.identity ?? '',
        rules: data.rules ?? '',
        custom: data.custom,
        memories: data.memories ?? [],
      };
    } catch {
      if (name === 'default') return { ...DEFAULT_PROFILE };
      throw new Error(`Profile '${name}' not found at ${filePath}`);
    }
  }
}
