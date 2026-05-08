# DEVLOG

## 2026-05-08 — v2.3.0 — optional profile memory loading

- Added `FilesystemProfileLoader(baseDir, { includeMemories: false })` so host apps can load profile identity/rules/custom fields without injecting profile memories
- When memory loading is disabled, JSON profile `memories` arrays are ignored and callers can pass app-selected memory through `PriestRequest.memory`
- This mirrors `priest` core v2.3.0 while preserving the TypeScript SDK's existing JSON profile layout

---

## 2026-04-25 — v2.2.0 — json_schema structured output

Added `jsonSchema`, `jsonSchemaName`, and `jsonSchemaStrict` to `OutputSpec`.

- **OpenAI-compat:** `response_format:{type:"json_schema", json_schema:{name, schema, strict}}` in both `complete` and `stream`.
- **Ollama (v0.5+):** `format:<schema_dict>`.
- **Anthropic:** schema description injected into system message via `buildBody`.
- `jsonSchema` takes precedence over `providerFormat` when both are set.
- `PriestEngine.specVersion` → `"2.2.0"`

---

## 2026-04-11 — Initial implementation

First implementation of `priest-typescript`, the TypeScript/Node.js SDK for the priest protocol.

npm package: `@priest-ai/core`

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

## 2026-04-12 — v1.0.0 release

- Added MIT LICENSE

## 2026-04-20 — v2.0.0 — context API redesign, memory dedup/trim, profile cache

Breaking changes matching priest core v2.0.0 spec.

**Schema changes:**
- `PriestRequest.systemContext` → `context` (raw system context, passed through untouched)
- `PriestRequest.extraContext` → `userContext` (appended to user turn)
- `PriestRequest.memory` added — dynamic memory entries, deduped and trimmable
- `PriestConfig.maxSystemChars` added — triggers tail-trim when set

**Context assembly (`buildMessages`):**
- Dynamic memory rendered under `## Memory\n\n` heading (after `## Loaded Memories\n\n`)
- Dedup: whitespace-stripped comparison; drops any `memory` entry matching a profile memory or earlier dynamic entry
- Trim: tail-first on `memory`, then `profileMemories`; `context`/rules/identity/custom/format instructions never trimmed

**Profile loader cache:**
- `FilesystemProfileLoader` now caches loaded profiles per instance, keyed on file mtime
- Invalidates automatically when the file changes

**Test suite:** 36 unit tests (up from 29). New tests cover memory block rendering, cross-source dedup, self-dedup, whitespace-stripped dedup, tail-trim, and no-trim guard.

**Spec version:** `PriestEngine.specVersion` → `"2.0.0"`
