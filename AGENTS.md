# AGENTS.md

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:

- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Commands

- `bun install` — Bun is the only package manager (never `package-lock.json`; `.gitignore` guards it).
- `bun test` — full suite, no network (fixtures are inline). Single file: `bun test plugin/catalog.test.ts`; filter: `bun test -t "name substring"`.
- `bun run typecheck` — `tsc --noEmit`. There is no lint script; formatting/linting runs via pre-commit hooks.
- Verification order: `bun test` then `bun run typecheck`.

## Pre-commit hooks rewrite files

`.pre-commit-config.yaml` runs prettier + end-of-file/trailing-whitespace fixers before the `tsc` gate. A first `git commit` may FAIL and MODIFY files; re-run `git add -A && git commit`. Hooks require `pre-commit install` once.

## Architecture facts

- Dual plugin entries, loaded by the opencode host WITHOUT bundling (TS/TSX straight from the package): server `plugin/index.ts` (exports `.`/`./server`) and TUI `plugin/tui.tsx` (exports `./tui`, registered in `~/.config/opencode/tui.json`). They run in separate processes and share state ONLY through on-disk files: `~/.cache/opencode-ollama-cloud/` (handoff `stats-<sessionID>.json`, `update.json`, catalog cache).
- `package.json` `files` is an explicit allowlist — a new source file must be added there or it will not ship on npm.
- The model catalog is NOT built here. This repo consumes `catalog.json` from upstream `srnoob2570/ollama-cloud-catalog` (models.dev shape + `x_ollama` extension; pricing embedded per-model in `cost`; fetched jsDelivr → raw GitHub → local cache → models.dev zero-cost fallback). Do not reintroduce local catalog scripts, schemas, or ajv — they were removed on purpose.
- Plugin knobs: `catalogUrl`, `timeoutMs`, `pricing` `"on"|"off"` (legacy `"reference"` == `"on"`), `stats`, `tui: "ensure"`. `index.ts` default-exports a single factory; opencode's legacy loader calls every exported function as a factory.

## LSP vs reality

`tsc --noEmit` is the source of truth. Known phantom/diagnostic noise: stale LSP errors for deleted `scripts/*` files, and `plugin/tui.tsx` errors about solid-js types / JSX runtime / `api.keymap` (those APIs come from the opencode TUI host at runtime, not from installed packages).

## Release flow

1. Bump `version` in `package.json` + add a `CHANGELOG.md` entry (English); releases live on branches `release/v*`.
2. Push tag `v*` → `publish.yml` publishes to npm. The workflow FAILS if the tag doesn't match `package.json`, and skips if the version is already on the registry. It deliberately runs on `ubuntu-latest` (npm OIDC trusted publishing does not support self-hosted runners).

- The self-hosted runner pool `[self-hosted, dockerless]` mentioned in workflows belongs to the upstream catalog repo.

## Vocabulary

Domain terms (`family`, LLM step, TTFT/TPS, ficha de modelo, cuantización) are defined in `CONTEXT.md` — use those exact names in code and docs.
