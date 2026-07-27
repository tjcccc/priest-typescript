# AGENTS

## Project

`@priest-ai/core` — the TypeScript SDK for the **priest** AI orchestration protocol. Implements the spec natively (no Python server, no FFI): provider transport, streaming, structured tool calling, sessions, profiles, memory/context assembly, compaction, cancellation, and images.

## Stack

- TypeScript (strict), maintained Node.js 22 and 24 LTS releases, compiled with `tsc` to `dist/`
- pnpm
- vitest
- better-sqlite3 (session store)

## Commands

- Build: `pnpm build`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`

Run typecheck + test before finishing.

## Boundaries

- `src/engine/` — `PriestEngine`, `StreamEvents`, `ContextBuilder`, `Compactor`, `ToolLoop`.
- `src/providers/` — provider adapters (Ollama, Anthropic, OpenAI-compatible). The request/response wire format is spec-defined; keep it conformant and covered by `tests/ProviderWire.test.ts`.
- `src/session/`, `src/profile/`, `src/schema/`, `src/errors/`, `src/util/` — session store, profile loading, tool/output schema types, error model, helpers.
- Public API is re-exported from `src/index.ts`; treat it as the stability surface.

## Spec sync (important)

- The canonical protocol spec lives in `../priest/spec/` (the `priest` / priest-core repo). This SDK currently leads spec adoption — new spec versions are implemented here first.
- A change to observable behavior (provider wire format, engine semantics, schemas) is a **spec change**: update `../priest/spec/behavior/` and its CHANGELOG, then propagate to the other SDKs — priest-core (Python), priest-dotnet, priest-rs, PriestSwift. Those SDKs currently lag this one; record in DEVLOG what shipped and which targets still need syncing.

## Versioning & docs

- SemVer in `package.json`; bump on a shippable change.
- `DEVLOG.md` is newest-first — add an entry per release with what shipped and what was verified.
- Update `README.md` when the public API or usage changes.
