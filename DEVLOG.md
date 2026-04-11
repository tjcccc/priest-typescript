# DEVLOG

## 2026-04-11 — Initial implementation

First implementation of `priest-node`, the Node.js SDK for the priest protocol.

npm package: `@tjcccc/priest`

Implements the priest protocol spec v1.0.0. Reference implementation: Python `priest-core`.

**What's implemented:**
- All three providers: Ollama (NDJSON streaming), OpenAI-compatible (SSE streaming), Anthropic (SSE streaming)
- Session persistence: `InMemorySessionStore` + `SQLiteSessionStore` (better-sqlite3)
- Profile loading: `FilesystemProfileLoader` + built-in default profile
- Context assembly: `buildMessages()` — mirrors `context_builder.py` exactly
- `PriestEngine.run()` and `stream()` — full spec-compliant implementations with async generators
- Error types: `PriestError` class + `PriestErrorCode` string union (values match spec)
- Schema types: all request/response types as TypeScript interfaces; `Session` as a class
- `JSONValue` recursive union type for heterogeneous JSON

**Dependencies:** `better-sqlite3` (runtime only). All HTTP via built-in `fetch` (Node 18+).

**Dev tools:** TypeScript 5.5, Vitest 2.

**Test suite:** 29 unit tests — ContextBuilder (9), Engine (8), SessionStore (8), Streaming (4).

**Spec version targeted:** 1.0.0 (asserted in `PriestEngine.specVersion`).
