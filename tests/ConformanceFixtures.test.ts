import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../priest/spec/conformance/v2.8',
);

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8')) as Record<string, unknown>;
}

describe('v2.8 language-neutral conformance fixtures', () => {
  it('loads every category declared by the manifest', () => {
    const manifest = load('manifest.json');
    expect(manifest.spec_version).toBe('2.8.0');
    const files = manifest.files as Array<{ category: string; path: string }>;
    expect(files.map(file => file.category)).toEqual([
      'context_assembly',
      'provider_request_bodies',
      'provider_response_parsing',
      'streaming_events',
      'tool_exchanges',
      'images',
      'usage',
      'compaction_metadata',
      'finish_reasons_and_errors',
      'reasoning',
    ]);
    for (const file of files) {
      const fixture = load(file.path);
      expect(fixture.spec_version).toBe('2.8.0');
      expect(fixture.category).toBe(file.category);
      expect(Array.isArray(fixture.cases)).toBe(true);
    }
  });

  it('enforces that cached and reasoning tokens are subsets, not additions to total', () => {
    const fixture = load('usage.json');
    const cases = fixture.cases as Array<{
      input_tokens: number | null;
      output_tokens: number | null;
      expected_total_tokens: number;
    }>;
    for (const item of cases) {
      expect((item.input_tokens ?? 0) + (item.output_tokens ?? 0))
        .toBe(item.expected_total_tokens);
    }
  });

  it('keeps opaque provider continuation values structurally unchanged', () => {
    const fixture = load('reasoning.json');
    const cases = fixture.cases as Array<Record<string, unknown>>;
    const openAI = cases.find(item => item.id === 'openai-summary-and-opaque-state')!;
    const providerItem = openAI.provider_item;
    const expected = openAI.expected as {
      continuation: Array<{ value: unknown }>;
    };
    expect(expected.continuation[0].value).toEqual(providerItem);
  });
});
