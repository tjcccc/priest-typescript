# DEVLOG

## 2026-07-27 — npm v3.0.0 — SQLite 13 and maintained Node LTS baseline

TypeScript SDK packaging/runtime change only; the public API, SQLite schema, timestamp representation, and protocol behavior are unchanged, so the protocol spec and sibling SDK implementations do not require synchronization.

- **Shared native SQLite major:** upgraded the sole runtime dependency from `better-sqlite3` 11 to `^13.0.1`, allowing file-linked consumers such as Marifold to use one v13 native SQLite implementation in-process instead of loading v11 and v13 against the same session database.
- **Runtime policy:** Node.js 22 and 24 LTS are supported through the engine range `^22.0.0 || ^24.0.0`; Node 18 and 20 are no longer supported. The project compiles against `@types/node` `^22.20.1`, matching the lowest supported runtime rather than adopting non-target Node 26 types.
- **Development dependencies:** refreshed `@types/better-sqlite3` to `^7.6.13`, retained TypeScript `^7.0.2`, upgraded Vitest to `^4.1.10`, and pinned Corepack to pnpm 11.17.0 with its integrity hash.
- **Database compatibility:** a database created through the public `SQLiteSessionStore` on better-sqlite3 11.10.0 contained three sessions and twelve ordered turns and passed `PRAGMA integrity_check`; after the dependency upgrade it was read, appended, closed, reopened, and checked again without schema migration or data loss.
- **Release implication:** dropping Node 18/20 is a breaking runtime compatibility change, so the npm package advances to 3.0.0 while `PriestEngine.specVersion` remains 2.8.0.
- **Verification:** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, and `pnpm test` (133 tests) pass on Node 24.18.0; `pnpm why better-sqlite3` reports exactly one installed version (13.0.1); `pnpm audit --prod` reports no known vulnerabilities; `pnpm outdated` reports only the intentionally excluded Node 26 type package. A packed tarball passed external consumer session round trips and SQLite integrity checks on Node 22.23.1 and Node 24.18.0.

## 2026-07-26 — v2.8.0 — OpenAI Responses, safe reasoning transport, and release cleanup

Protocol/spec and npm package release candidate. This version is intentionally being completed and exercised locally by Marifold before any npm publication or sibling-SDK propagation.

- **First-class `OpenAIResponsesProvider`:** explicit Responses endpoint configuration; complete and semantic SSE streaming; text and image input; function tools and stateless tool-result continuation; JSON and JSON Schema output; cached/reasoning usage; caller cancellation, connect timeout, custom headers, and optional dispatcher; provider-native overrides without model-name endpoint guessing.
- **Provider-neutral reasoning:** new `ReasoningConfig`, `ReasoningInfo`, `OpaqueReasoningState`, and `reasoning_summary_delta`. Only provider-supplied summaries are displayable. OpenAI encrypted reasoning items and Anthropic signed thinking blocks are replayed unchanged inside the current tool loop; no reasoning state is persisted in sessions. Ollama's raw reasoning trace is deliberately not surfaced.
- **Usage and finish reasons:** `reasoningTokens` is reported as a subset of `outputTokens`; `content_filter` is now represented in the public `FinishedReason` union.
- **Tool loop:** `runWithTools` carries reasoning continuation into the next assistant exchange automatically.
- **Canonical spec:** added the v2.8 behavior documents, repaired stale 2.2–2.6 JSON schemas, and added language-neutral conformance fixtures for context, provider requests/responses, streaming, tools, images, usage, compaction, finish/errors, and reasoning.
- **Release cleanup:** `PriestEngine.specVersion` and package version are 2.8.0; all current README spec references were corrected; cached input tokens, conversation compaction, session context windows, Responses, and reasoning are now documented.
- **Compatibility:** `OpenAICompatProvider` wire behavior is unchanged. Existing provider adapters remain valid because new fields are optional; exhaustive event-union switches may need a `reasoning_summary_delta` case.
- **Verification:** `pnpm typecheck`, `pnpm build`, `pnpm test` (132 tests), and `pnpm pack --dry-run`, including declaration/package-content inspection.

## 2026-07-26 — npm v2.7.1 — TypeScript 7 native compiler

TypeScript SDK tooling only; no public API or spec/protocol change (`specVersion` stays `2.6.0`), so other-SDK (Python/Rust/.NET/Swift) sync is not required.

- Upgraded the development compiler from TypeScript 5 to TypeScript 7.0.2, adopting the stable Go-native `tsc` implementation.
- Replaced the removed legacy Node module-resolution mode with `NodeNext`. Because this package remains untyped CommonJS, emitted JavaScript and package consumption stay backward compatible.
- Verification: `pnpm build`, `pnpm typecheck`, and `pnpm test`.

## 2026-07-10 — npm v2.7.0 — OpenAI-compat proxy dispatcher

TypeScript SDK only; no spec/protocol change (`specVersion` stays `2.6.0`), so other-SDK (Python/Rust/.NET/Swift) sync is not required.

- **`OpenAICompatProvider` now accepts an optional `dispatcher` option** (`OpenAICompatProviderOptions.dispatcher`), applied to both `complete()` and `streamEvents()` fetch calls. Node's built-in `fetch` ignores `HTTPS_PROXY`, so a caller behind a proxy had no way to route OpenAI-compatible chat/completions requests — the only escape was a global undici dispatcher, which also proxies unrelated (e.g. localhost) traffic. This lets the caller pass a per-request undici dispatcher (e.g. a `ProxyAgent`) so a single provider can be proxied while others stay direct. Typed as `unknown` to avoid a hard undici type dependency; spread into the fetch init only when set, so behavior is unchanged when omitted.
- Motivating case: a downstream (marifold) user in China needed to reach `api.x.ai` through a proxy for one provider while keeping local/other providers direct. The Responses-API path there was already proxyable; the delegated chat/completions path (this provider) was not.
- No new tests: purely additive plumbing with no wire-format change; existing 109 pass. `PriestEngine.specVersion` unchanged.

## 2026-06-27 — v2.6.1 — streaming token usage (OpenAI-compat)

TypeScript SDK only; other-SDK (Python/Rust/.NET/Swift) sync intentionally deferred.

Synchronization status update (2026-07-26): this was the at-release status. Python, .NET, Rust, and Swift subsequently synchronized through protocol 2.6.1.

- **`OpenAICompatProvider` now sets `stream_options: { include_usage: true }` on streaming requests.** Per the OpenAI-compatible streaming protocol, gateways emit a final usage chunk only when this option is set; without it, usage is reported solely for models that volunteer it. On DashScope (Alibaba Bailian) the Qwen models volunteered usage but third-party models (e.g. `deepseek-v4-flash`) did not, so streaming chat showed no token cost / context. The streaming parser already captured `parsed.usage`; this just asks for it. Non-streaming (`complete`) is unchanged (it reads `usage` from the single JSON response). `providerOptions` still overrides, so a backend that rejects the field can opt out.
- Tests: ProviderWire wire-format checks that streaming sends `stream_options.include_usage` and non-streaming omits it, plus a `providerOptions` override case (109 total pass).

## 2026-06-25 — v2.6.0 — session turn window

TypeScript SDK leads this spec version; other-SDK (Python/Rust/.NET/Swift) sync pending.

Synchronization status update (2026-07-26): this was the at-release status. All four sibling SDKs subsequently synchronized through protocol 2.6.1.

- **`PriestConfig.sessionContextTurns`:** a hard cap on how many recent session turns are replayed into a request. When set, only the last N turns (after any compaction summary) reach the model; older turns stay on disk but are not sent. `0` replays none (summary only); unset replays all (default — fully backward compatible). Independent of `maxContextTokens`, which remains the budget-triggered compaction safety net.
- **`ContextBuilder`:** the Step-5 replay now starts at `max(summarizedThrough, turns.length - N)` when a window is set — so a window never un-hides turns already folded into the summary, and the summary prefix is unchanged. An **odd-sized window snaps down to a user turn** (floored by `summarizedThrough`) so the replay never opens on an orphan assistant reply, which strict OpenAI-compatible backends (e.g. DashScope) reject. Deterministic and free (no extra summarization calls). Threaded through `buildMessages({ sessionContextTurns })` from `request.config.sessionContextTurns`.
- **Use case:** lets a host bound per-turn cost on token-limited models by sending only the last few turns, instead of growing history until the token budget trips compaction.
- `PriestEngine.specVersion` → `"2.6.0"`. Tests: 107 (5 new — turn-window: all/last-N/0/odd-window user-snap/summarizedThrough-floor).

---

## 2026-06-25 — v2.5.0 — conversation compaction + cached-token visibility

TypeScript SDK leads this spec version; spec doc + other-SDK (Python/Rust/.NET/Swift) sync pending until the TS surface stabilizes.

Synchronization status update (2026-07-26): this was the at-release status. The canonical spec and all four sibling SDKs subsequently synchronized through protocol 2.6.1.

- **Cached input tokens:** `UsageInfo.cachedInputTokens` and `AdapterResult.cachedInputTokens` / the `usage` stream event now carry the prompt-cache hit count. Parsed from OpenAI-compat `usage.prompt_tokens_details.cached_tokens` (DashScope/OpenAI) and Anthropic `cache_read_input_tokens` (complete + stream). Lets hosts see prefix-cache behavior instead of only gross input.
- **Conversation compaction:** sessions can now be bounded instead of replaying full history forever (cost was linear per turn, quadratic per session). New `PriestConfig.maxContextTokens` (enables compaction; unset = off, fully backward compatible) and `compactionKeepTurns` (default 6). When a chat turn's reported input usage crosses ~80% of the budget, the engine folds older turns into a running summary via a provider summarization call and replays only `summary + recent tail`. Non-destructive: raw turns stay in the store, only the replayed view shrinks; the summary lives in session metadata (`__compaction`) so the SQLite schema and cross-SDK interop are unchanged.
- **Recursive + safe:** repeated compaction folds only newly-aged turns into the existing summary. The summary prompt is told durable facts already live in memory (avoids double-paying the memory extractor). Trigger is measured on plain chat turns only — agent/tool turns are skipped (their input reflects intra-run tool context, not the clean session; that growth is host-side).
- **APIs:** `engine.compactSession(id, config, options?)` for a manual `/compact`; `ContextBuilder` injects a `## Conversation so far (summary)` system section and skips folded turns. New `Compactor` exports (`shouldCompact`, `planCompaction`, `buildSummaryMessages`, constants), `CompactionState`, `COMPACTION_METADATA_KEY`.
- `PriestEngine.specVersion` → `"2.5.0"`. Tests: 100 (16 new — 5 cached-token, 11 compaction).

---

## 2026-06-12 — v2.4.0 — tool calling, structured streaming, cancellation, images

Spec 2.4.0 implementation (reference implementation for this spec version; Python sync pending).

Synchronization status update (2026-07-26): this was the at-release status. Python, .NET, Rust, and Swift subsequently synchronized through protocol 2.6.1.

- **Tool calling (caller executes):** `PriestRequest.tools` / `toolChoice` / `toolExchange`, `PriestResponse.toolCalls`, `finishedReason: 'tool_calls'`. Wire mappings for all three providers (OpenAI tools/tool_calls, Anthropic tool_use/tool_result with user-message merging, Ollama tools with synthesized `call_N` ids and `tool_name` results). Tool exchange turns are never persisted in sessions — schema interop with pre-2.4 SDKs preserved.
- **`runWithTools()` loop helper:** generic call → execute → re-call loop with caller executor, optional `onToolCall` approval hook, iteration cap, and exchange trace.
- **`streamEvents()`:** typed streaming (`text_delta`, `tool_call_start/delta/end`, `usage`, `done` with full `PriestResponse`); engine fallback wraps plain adapter `stream()`; `stream()` reimplemented as a filter over it.
- **Cancellation:** `run`/`stream`/`streamEvents` accept `{ signal: AbortSignal }`; new `REQUEST_ABORTED` error code distinct from `PROVIDER_TIMEOUT`; connect timeout no longer applies once a stream's headers arrive.
- **Images:** `PriestRequest.images` (`ImageInput` path/url/data parity with Python), OpenAI-format content blocks in the context builder, per-provider conversion (Ollama base64 `images` array, Anthropic image source blocks). New `IMAGE_LOAD_ERROR` code.
- Anthropic default `max_tokens` corrected to the spec-defined 8096 (was 1024).
- Finish-reason mapping tables aligned with the Python reference for all providers.
- `PriestEngine.specVersion` → `"2.4.0"`. Tests: 84 (41 new).

---

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
