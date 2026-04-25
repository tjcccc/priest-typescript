# @priest-ai/core

TypeScript SDK for the [priest](https://github.com/tjcccc/priest) AI orchestration protocol.

Node.js 18+ · TypeScript 5+ · One dependency (`better-sqlite3` for SQLite sessions)

---

## Overview

`@priest-ai/core` is a TypeScript package that implements the priest protocol spec v2.0.0 natively — no Python server, no FFI. It is designed for Node.js backends, serverless functions, CLI tools, and any TypeScript host that needs to talk to a local or remote AI provider.

The core API is two methods on `PriestEngine`:

| Method | Returns | Use when |
|--------|---------|----------|
| `run(request)` | `Promise<PriestResponse>` | You need structured metadata (usage, latency, session info) |
| `stream(request)` | `AsyncGenerator<string>` | You want to yield text as it arrives |

---

## Installation

```bash
npm install @priest-ai/core
# or
pnpm add @priest-ai/core
```

Then import:

```ts
import { PriestEngine, OllamaProvider, FilesystemProfileLoader } from '@priest-ai/core';
```

---

## Quick Start

### Single run with Ollama

```ts
import { PriestEngine, OllamaProvider, FilesystemProfileLoader } from '@priest-ai/core';

const engine = new PriestEngine(
  new FilesystemProfileLoader('./profiles'),
  undefined,
  { ollama: new OllamaProvider('http://localhost:11434') },
);

const response = await engine.run({
  config: { provider: 'ollama', model: 'llama3.2' },
  prompt: 'What is the capital of France?',
});

if (response.ok) {
  console.log(response.text);
}
```

### Streaming

```ts
for await (const chunk of engine.stream({
  config: { provider: 'ollama', model: 'llama3.2' },
  prompt: 'Tell me a story.',
})) {
  process.stdout.write(chunk);
}
```

### Anthropic or OpenAI-compatible providers

```ts
import { AnthropicProvider, OpenAICompatProvider } from '@priest-ai/core';

const engine = new PriestEngine(
  new FilesystemProfileLoader('./profiles'),
  undefined,
  {
    anthropic: new AnthropicProvider('sk-ant-...'),
    openai:    new OpenAICompatProvider('https://api.openai.com', 'sk-...'),
  },
);

const response = await engine.run({
  config: { provider: 'anthropic', model: 'claude-opus-4-6' },
  prompt: 'Summarize the priest protocol in one sentence.',
});
```

---

## Session Continuity

Pass a `session` field to persist conversation history across calls.

```ts
import { SQLiteSessionStore } from '@priest-ai/core';

const store = new SQLiteSessionStore('./sessions.db');
store.open();

const engine = new PriestEngine(
  new FilesystemProfileLoader('./profiles'),
  store,
  { ollama: new OllamaProvider() },
);

const sessionId = 'user-123-chat';

// First turn — session is created automatically
await engine.run({
  config: { provider: 'ollama', model: 'llama3.2' },
  prompt: 'My name is Alex.',
  session: { id: sessionId },
});

// Second turn — session is continued
const r = await engine.run({
  config: { provider: 'ollama', model: 'llama3.2' },
  prompt: 'What is my name?',
  session: { id: sessionId },
});
// r.text → "Your name is Alex."
```

`session` field behavior:

| `continueExisting` | `createIfMissing` | Result |
|--------------------|-------------------|--------|
| `true` (default) | `true` (default) | Load existing session or create it |
| `true` | `false` | Load existing or throw `SESSION_NOT_FOUND` |
| `false` | — | Always create a new session |

The SQLite store is interoperable with the Python `priest` `SqliteSessionStore` and the Swift `SQLiteSessionStore` — the schema and timestamp format are identical across all implementations.

---

## Profiles

A profile supplies `identity`, `rules`, and optional `custom` and `memories` that shape the system prompt.

```
profiles/
├── default.json
└── coder.json
```

```ts
const loader = new FilesystemProfileLoader('./profiles');
```

Falls back to the built-in default profile when the named file is not found.

Profile format — `default.json`:

```json
{
  "identity": "You are a helpful assistant.",
  "rules": "Be honest. Do not make things up.\nBe concise unless the user asks for depth.",
  "memories": []
}
```

---

## Memory and Context

```ts
const response = await engine.run({
  config: { provider: 'ollama', model: 'llama3.2' },
  prompt: 'What should I work on today?',

  // Raw system context — injected first, never trimmed or deduped
  context: ['Today is Monday. App: ProjectManager'],

  // Dynamic memory — deduped against profile memories and each other
  memory: ['User prefers bullet points.', 'Active sprint: v3.0'],

  // Per-turn user context — appended to the user message
  user_context: ['Recent tasks: [fix login bug, update README]'],
});
```

When `max_system_chars` is set on the config, the engine trims `memory` entries tail-first, then `profile.memories` tail-first. `context`, rules, identity, custom, and format instructions are never trimmed.

```ts
const response = await engine.run({
  config: { provider: 'ollama', model: 'llama3.2', max_system_chars: 4096 },
  prompt: 'Summarize my notes.',
  memory: longMemoryList,
});
```

---

## Output Format Hints

```ts
const response = await engine.run({
  config: { provider: 'ollama', model: 'llama3.2' },
  prompt: 'List three planets as JSON.',
  output: { providerFormat: 'json', promptFormat: 'json' },
});
```

`providerFormat` activates the provider's native JSON mode. `promptFormat` injects a natural-language instruction into the system prompt.

For strict schema compliance, use `jsonSchema` instead:

```ts
const response = await engine.run({
  config: { provider: 'openai', model: 'gpt-4o-mini' },
  prompt: 'Give me a person object.',
  output: {
    jsonSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name', 'age'],
    },
    jsonSchemaName: 'person',   // optional, defaults to "response"
    jsonSchemaStrict: false,    // true requires additionalProperties:false on all objects
  },
});
```

`jsonSchema` maps to `response_format:{type:"json_schema"}` for OpenAI-compat, `format:<schema>` for Ollama (v0.5+), and system message injection for Anthropic. It takes precedence over `providerFormat` when both are set.

`response.text` is always the raw string. `@priest-ai/core` never parses the output.

---

## Error Handling

Two errors are always thrown and never captured into `response.error`:

- `PROVIDER_NOT_REGISTERED` — no adapter found for the requested provider key.
- `SESSION_NOT_FOUND` — session lookup failed and `createIfMissing` is `false`.

All other provider errors (network failures, rate limits, timeouts) are caught and placed into `response.error`. Check `response.ok` before reading `response.text`.

```ts
import { PriestError } from '@priest-ai/core';

try {
  const response = await engine.run(request);
  if (response.ok) {
    console.log(response.text);
  } else {
    console.error('Provider error:', response.error?.message);
  }
} catch (err) {
  if (err instanceof PriestError) {
    // PROVIDER_NOT_REGISTERED or SESSION_NOT_FOUND
    console.error('Fatal:', err.code, err.message);
  }
}
```

---

## Providers

| Key | Class | Notes |
|-----|-------|-------|
| any | `OllamaProvider` | NDJSON streaming; local by default (`http://localhost:11434`) |
| any | `AnthropicProvider` | SSE streaming; requires API key |
| any | `OpenAICompatProvider` | SSE streaming; works with any OpenAI-compatible endpoint |

Provider keys are arbitrary strings — the key you register in the `adapters` map must match the `provider` field in the request config.

---

## Custom Providers

Implement `ProviderAdapter` to add your own backend:

```ts
import { ProviderAdapter, Message, AdapterResult, PriestConfig, OutputSpec } from '@priest-ai/core';

class MyProvider implements ProviderAdapter {
  async complete(messages: Message[], config: PriestConfig): Promise<AdapterResult> {
    // call your API
    return { text: '...', finishReason: 'stop' };
  }

  async *stream(messages: Message[], config: PriestConfig): AsyncGenerator<string> {
    yield 'chunk1';
    yield 'chunk2';
  }
}

const engine = new PriestEngine(loader, store, { my: new MyProvider() });
```

---

## Spec

`@priest-ai/core` targets priest protocol spec **v2.0.0**. The spec lives in the [`priest`](https://github.com/tjcccc/priest) repository under `spec/`.

```ts
PriestEngine.specVersion  // '2.0.0'
```

---

## Requirements

- Node.js 18+
- TypeScript 5+ (if using TypeScript)
- `better-sqlite3` is the only runtime dependency (required for `SQLiteSessionStore`; tree-shaken if unused in bundler setups)
