# CLAUDE.md

Project memory for Claude Code. Kept thin on purpose — this loads every turn.

## Authoritative docs (read for design; don't restate them)

- `AGENTS.md` — stack, boundaries, validation gates, spec-sync rule.
- `README.md` — public API surface and usage (comprehensive; keep it in sync with API changes).
- `DEVLOG.md` — newest-first change log.
- `../priest/spec/` — the canonical priest protocol spec this SDK implements.

## Non-negotiables

- This is the TypeScript SDK and currently **leads spec adoption** (new spec versions land here first). A change to observable behavior is a spec change: reflect it in `../priest/spec/behavior/` and propagate to the other SDKs (priest-core/Python, priest-dotnet, priest-rs, PriestSwift); note in DEVLOG which still lag.
- Native implementation only — no Python server, no FFI.
- Run `pnpm typecheck && pnpm test` before finishing; add wire/behavior tests for provider or engine changes.
