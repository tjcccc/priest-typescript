import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildMessages } from '../src/engine/ContextBuilder';
import { DEFAULT_PROFILE } from '../src/profile/DefaultProfile';
import { ContentBlock } from '../src/providers/ProviderAdapter';
import { validateImageInput } from '../src/schema/ImageInput';

const tmp = mkdtempSync(join(tmpdir(), 'priest-images-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

describe('ImageInput validation', () => {
  it('accepts exactly one source', () => {
    expect(() => validateImageInput({ data: 'abc' })).not.toThrow();
    expect(() => validateImageInput({ url: 'https://x/y.png' })).not.toThrow();
  });

  it('rejects zero or multiple sources', () => {
    expect(() => validateImageInput({})).toThrow(/exactly one/);
    expect(thrownBy(() => validateImageInput({ data: 'abc', url: 'https://x' }))).toMatchObject({ code: 'REQUEST_INVALID' });
  });
});

describe('buildMessages with images', () => {
  it('builds multimodal user content with images first and text last', () => {
    const messages = buildMessages({
      profile: DEFAULT_PROFILE,
      session: undefined,
      prompt: 'What is in this image?',
      images: [{ data: 'BASE64DATA', mediaType: 'image/png' }],
    });

    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    const blocks = user.content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,BASE64DATA' } });
    expect(blocks[1]).toEqual({ type: 'text', text: 'What is in this image?' });
  });

  it('passes URL sources through unchanged', () => {
    const messages = buildMessages({
      profile: DEFAULT_PROFILE,
      session: undefined,
      prompt: 'Describe',
      images: [{ url: 'https://example.com/cat.jpg' }],
    });
    const blocks = messages[messages.length - 1].content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } });
  });

  it('reads path sources as base64 with the default media type', () => {
    const file = join(tmp, 'pixel.jpg');
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
    const messages = buildMessages({
      profile: DEFAULT_PROFILE,
      session: undefined,
      prompt: 'Describe',
      images: [{ path: file }],
    });
    const blocks = messages[messages.length - 1].content as ContentBlock[];
    const url = (blocks[0] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(url.endsWith(Buffer.from([0xff, 0xd8, 0xff]).toString('base64'))).toBe(true);
  });

  it('throws IMAGE_LOAD_ERROR for unreadable paths', () => {
    expect(thrownBy(() => buildMessages({
      profile: DEFAULT_PROFILE,
      session: undefined,
      prompt: 'Describe',
      images: [{ path: join(tmp, 'missing.jpg') }],
    }))).toMatchObject({ code: 'IMAGE_LOAD_ERROR' });
  });

  it('keeps plain string content when no images are given', () => {
    const messages = buildMessages({ profile: DEFAULT_PROFILE, session: undefined, prompt: 'Hi' });
    expect(typeof messages[messages.length - 1].content).toBe('string');
  });
});
