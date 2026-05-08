import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemProfileLoader } from '../src/profile/FilesystemProfileLoader';

function writeProfile(dir: string, name: string, data: object) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data));
}

describe('FilesystemProfileLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loads a profile from disk', () => {
    writeProfile(tmpDir, 'bot', { identity: 'I am a bot.', rules: 'Be nice.', memories: [] });
    const loader = new FilesystemProfileLoader(tmpDir);
    const profile = loader.load('bot');
    expect(profile.name).toBe('bot');
    expect(profile.identity).toBe('I am a bot.');
  });

  it('loads profile memories by default', () => {
    writeProfile(tmpDir, 'bot', { identity: 'Bot.', rules: '', memories: ['Remember me.'] });
    const loader = new FilesystemProfileLoader(tmpDir);
    const profile = loader.load('bot');
    expect(profile.memories).toEqual(['Remember me.']);
  });

  it('can disable profile memory loading', () => {
    writeProfile(tmpDir, 'bot', { identity: 'Bot.', rules: '', memories: ['Remember me.'] });
    const loader = new FilesystemProfileLoader(tmpDir, { includeMemories: false });
    const profile = loader.load('bot');
    expect(profile.memories).toEqual([]);
  });

  it('returns default profile when name is "default" and file missing', () => {
    const loader = new FilesystemProfileLoader(tmpDir);
    const profile = loader.load('default');
    expect(profile.name).toBe('default');
  });

  it('throws when profile not found and name is not "default"', () => {
    const loader = new FilesystemProfileLoader(tmpDir);
    expect(() => loader.load('missing')).toThrow();
  });

  it('cache hit: returns same Profile instance when mtime unchanged', () => {
    writeProfile(tmpDir, 'bot', { identity: 'Bot.', rules: '', memories: [] });
    const loader = new FilesystemProfileLoader(tmpDir);
    const first = loader.load('bot');
    const second = loader.load('bot');
    expect(second).toBe(first);
  });

  it('cache invalidation: returns new instance after file is modified', () => {
    writeProfile(tmpDir, 'bot', { identity: 'Bot v1.', rules: '', memories: [] });
    const loader = new FilesystemProfileLoader(tmpDir);
    const first = loader.load('bot');

    // Ensure mtime advances (FAT-resolution filesystems may need a tick)
    const futureMs = Date.now() + 2000;
    fs.utimesSync(path.join(tmpDir, 'bot.json'), new Date(futureMs), new Date(futureMs));

    const second = loader.load('bot');
    expect(second).not.toBe(first);
  });
});
