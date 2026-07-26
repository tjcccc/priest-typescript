# @priest-ai/core

TypeScript SDK for the [priest](https://github.com/tjcccc/priest) AI orchestration protocol.

Node.js 18+ · Native TypeScript 7 · One dependency (`better-sqlite3` for SQLite sessions)

---

## Overview

`@priest-ai/core` is a TypeScript package that implements the priest protocol spec v2.8.0 natively — no Python server, no FFI. It is designed for Node.js backends, serverless functions, CLI tools, and any TypeScript host that needs to talk to a local or remote AI provider.

The core API is three methods on `PriestEngine` plus a tool loop helper:

| Method | Returns | Use when |
|--------|---------|----------|
| `run(request, options?)` | `Promise<PriestResponse>` | You need structured metadata (usage, latency, session info, tool calls) |
| `stream(request, options?)` | `AsyncGenerator<string>` | You want to yield text as it arrives |
| `streamEvents(request, options?)` | `AsyncGenerator<PriestStreamEvent>` | You want text deltas, tool-call progress, usage, and a final `PriestResponse` while streaming |
| `runWithTools(engine, request, executor, hooks?)` | `Promise<ToolLoopResult>` | You want the call → execute → re-call tool loop handled for you |

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

### Anthropic, OpenAI Responses, or OpenAI-compatible providers

```ts
import {
  AnthropicProvider,
  OpenAICompatProvider,
  OpenAIResponsesProvider,
} from '@priest-ai/core';

const engine = new PriestEngine(
  new FilesystemProfileLoader('./profiles'),
  undefined,
  {
    anthropic: new AnthropicProvider('sk-ant-...'),
    responses: new OpenAIResponsesProvider('https://api.openai.com', 'sk-...'),
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
Use `new FilesystemProfileLoader('./profiles', { includeMemories: false })` when the host app owns memory selection and passes selected memory through `PriestRequest.memory`.

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
  userContext: ['Recent tasks: [fix login bug, update README]'],
});
```

When `maxSystemChars` is set on the config, the engine trims `memory` entries tail-first, then `profile.memories` tail-first. `context`, rules, identity, custom, and format instructions are never trimmed.

```ts
const response = await engine.run({
  config: { provider: 'ollama', model: 'llama3.2', maxSystemChars: 4096 },
  prompt: 'Summarize my notes.',
  memory: longMemoryList,
});
```

### Bounded conversation context

Long-lived sessions have two independent controls:

```ts
const config = {
  provider: 'responses',
  model: 'gpt-5.6',

  // Hard replay window: only the latest 12 raw turns are sent.
  sessionContextTurns: 12,

  // Usage-triggered compaction safety net.
  maxContextTokens: 100_000,
  compactionKeepTurns: 6,
};
```

`sessionContextTurns` limits how many recent raw turns are replayed on every request. `0` sends only an existing compaction summary; leaving it unset replays all eligible turns.

`maxContextTokens` enables conversation compaction. When the previous clean chat turn reports input usage at roughly 80% of that budget, the next run summarizes older turns and keeps the recent tail. Raw session turns are not deleted; the running summary is stored in session metadata under `__compaction`. Use `engine.compactSession(id, config, options?)` to compact manually.

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

`jsonSchema` maps to `text.format:{type:"json_schema"}` for OpenAI Responses, `response_format:{type:"json_schema"}` for OpenAI-compat, `format:<schema>` for Ollama, and system message injection for Anthropic. It takes precedence over `providerFormat` when both are set.

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
| any | `OpenAIResponsesProvider` | First-class Responses API; semantic SSE, tools, images, structured output, reasoning summaries |
| any | `OpenAICompatProvider` | SSE streaming; works with any OpenAI-compatible endpoint |

Provider keys are arbitrary strings — the key you register in the `adapters` map must match the `provider` field in the request config.

### OpenAI Responses endpoint and proxy configuration

```ts
const provider = new OpenAIResponsesProvider(
  'https://api.openai.com',
  process.env.OPENAI_API_KEY,
  {
    // Optional exact endpoint; no model-name endpoint guessing is performed.
    url: 'https://api.openai.com/v1/responses',
    headers: { 'X-Application': 'my-host' },
    dispatcher: proxyAgent, // optional undici-compatible dispatcher
  },
);
```

The provider defaults to `store: false`, because priest owns conversation and tool-loop state. `config.providerOptions` can override provider-native fields such as `store`, `temperature`, or service settings. `model`, assembled `input`, and the operation's `stream` mode remain adapter-owned.

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

## Tool Calling

The SDK transports tool definitions and calls; **your code executes the tools**. Either drive the loop yourself with `run()` + `request.toolExchange`, or use the helper:

```ts
import { runWithTools } from '@priest-ai/core';

const { response, exchange } = await runWithTools(
  engine,
  {
    config: { provider: 'ollama', model: 'qwen3:8b' },
    prompt: 'What does package.json define as the build script?',
    tools: [{
      name: 'read_file',
      description: 'Read a local file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
  },
  async call => ({ content: await readFileSomehow(call.arguments.path as string) }),
  {
    onToolCall: async call => ({ approved: call.name === 'read_file' }),  // optional approval gate
    maxIterations: 5,
  },
);

console.log(response.text);
```

Manual loop: when `response.execution.finishedReason === 'tool_calls'`, execute `response.toolCalls`, append an `{kind:'assistant', toolCalls, reasoning: response.reasoning}` turn plus `{kind:'tool_result', ...}` turns to `request.toolExchange`, and call `run()` again. `runWithTools()` copies the reasoning continuation automatically. Tool exchange turns are never persisted in sessions — only the original prompt and the final assistant text are stored.

---

## Reasoning

Reasoning is optional and provider/model support varies:

```ts
const response = await engine.run({
  config: {
    provider: 'responses',
    model: 'gpt-5.6',
    reasoning: {
      enabled: true,
      effort: 'medium',
      summary: 'auto',
    },
  },
  prompt: 'Plan the next operation.',
});

console.log(response.reasoning?.summary);          // provider-supplied summary
console.log(response.usage?.reasoningTokens);      // subset of outputTokens
```

Priest never exposes private chain-of-thought:

- OpenAI Responses summary blocks and Anthropic summarized thinking are displayable.
- Signed/encrypted provider state is carried opaquely during the current tool loop and replayed unchanged.
- Ollama's `message.thinking` is documented as a reasoning trace, so priest does not expose it as a summary.
- Reasoning continuation is never persisted in sessions.

---

## Structured Streaming

```ts
for await (const event of engine.streamEvents(request, { signal: controller.signal })) {
  switch (event.type) {
    case 'text_delta':     process.stdout.write(event.text); break;
    case 'reasoning_summary_delta': console.error(event.text); break;
    case 'tool_call_end':  console.log('tool requested:', event.toolCall.name); break;
    case 'done':           console.log('\nusage:', event.response.usage); break;
  }
}
```

The terminal `done` event carries the full `PriestResponse`. Provider errors land in `done.response.error` (like `run()`), not as thrown exceptions (unlike `stream()`).

`stream()` continues to yield answer text only. Use `streamEvents()` to receive provider-supplied reasoning-summary deltas.

---

## Usage and cached input

When a provider reports usage, `response.usage` can include:

```ts
{
  inputTokens,
  outputTokens,
  totalTokens,
  cachedInputTokens,
  reasoningTokens,
}
```

`cachedInputTokens` is the portion of input served from a provider prompt cache. `reasoningTokens` is a subset of `outputTokens`; neither subset is added again when calculating `totalTokens`.

---

## Cancellation

`run()`, `stream()`, and `streamEvents()` accept `{ signal: AbortSignal }`. Caller aborts surface as `REQUEST_ABORTED`; timeouts remain `PROVIDER_TIMEOUT`.

---

## Images

```ts
await engine.run({
  config: { provider: 'ollama', model: 'llama3.2-vision' },
  prompt: 'What is in this image?',
  images: [{ path: './photo.jpg', mediaType: 'image/jpeg' }],  // or { url } / { data }
});
```

Exactly one of `path`/`url`/`data` per image. Ollama requires base64 sources (`path` or `data`); OpenAI Responses, OpenAI-compatible, and Anthropic accept all three. Images are not persisted in sessions.

---

## Spec

`@priest-ai/core` targets priest protocol spec **v2.8.0**. The spec lives in the [`priest`](https://github.com/tjcccc/priest) repository under `spec/`.

```ts
PriestEngine.specVersion  // '2.8.0'
```

---

## Requirements

- Node.js 18+
- TypeScript 7 is used to build the package
- `better-sqlite3` is the only runtime dependency (required for `SQLiteSessionStore`; tree-shaken if unused in bundler setups)
