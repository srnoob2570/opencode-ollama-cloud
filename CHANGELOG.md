# Changelog

Entries here follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html).
Each version also lives on the [releases page](https://github.com/srnoob2570/opencode-ollama-cloud/releases).

## [Unreleased]

## [0.1.4] - 2026-09-01

### Added

- **Streaming stats (opt-out), idea by [@adilfaisal01](https://github.com/adilfaisal01)**: the plugin measures TTFT and tokens/s per LLM step client-side — wire-accurate for `ollama-cloud` (wrapped provider `fetch` + final `usage` chunk), event-derived for any other provider — and shows a live session average (`38.2 tok/s · TTFT 380 ms · Session average`) next to the token counter. The average belongs to the session, not the model: no per-model breakdown, no reset when switching models, main thread only (subagents, titlegen and compaction excluded by verified signals), in-memory per session. Requires the second plugin entry `"@srnoob2570/opencode-ollama-cloud/tui"`; the TUI plugin API it uses is present but undocumented in opencode 1.18.25, so the stats UI degrades silently when the API moves. `stats: "off"` on both entries reduces the plugin to its exact previous behavior.
- `/stats` and `/model` TUI dialogs: session summary + latest responses, and the model card (quantization, family, capabilities, limits, release, reference price when `pricing: "reference"`).
- **Quantization in the catalog and the model card**: the updater extracts the raw value Ollama declares (registry config blob `file_type` via `<ref>-cloud` manifests, cross-checked against `POST /api/show`; disagreements recorded in `conflicts`, CI advises). Coverage: 15/19 from the registry, `glm-5.2` → FP8 and `nemotron-3-ultra` → NVFP4 carried as researched implicit values with provenance, `minimax-m3`/`minimax-m2.7` literal `unknown`. Optional, shape-only, no closed enum — new Ollama formats cannot break the updater. Disclosure: **declared, not guaranteed** (the remote inference precision is not documented by Ollama).

### Removed

- **Type-level breaking**: the unused `pricing` field was dropped from the exported `PluginOpts` type. The user-facing `pricing` plugin option (`"off" | "reference"` in the opencode config) is unchanged — only code constructing the internal `PluginOpts` type with a `pricing` property will fail typecheck on upgrade. Runtime behavior is identical.

### Changed

- Internal simplification pass: shared test fixtures, unified `family` vocabulary, single models.dev seed URL, strict updater CLI (`[check|update] [--force]`, unknown arguments now exit 1 instead of running an update).

### CI

- Catalog validation now checks the published JSON schema too (`ajv` + `ajv-formats`), not only the hand-mirrored `isCatalog` — the two contracts can no longer drift apart silently.

## [0.1.3] - 2026-08-31

### Added

- Reference prices (opt-in): the catalog ships an upstream-API reference price per model. Pricing resolves automatically from models.dev first-party entries, with manual corrections in `catalog/pricing-overrides.json` (overrides win; override-vs-seed disagreements are recorded in the catalog's `conflicts`).
- `pricing: "reference"` plugin option: opencode's session cost counter shows the reference rate. Default `off` — and models without pricing data stay at $0 (no partial estimates).

### Fixed

- Updater hardening: transient models.dev outages abort loudly instead of publishing a regressed catalog; catalog writes are atomic and self-heal from torn files; malformed overrides are ignored with a warning; marketplace price ties now resolve deterministically; override `asOf` keeps the date the value was taken.

### Docs

- Recommend `--force --global` for the install command, since opencode has no update command.
- Reference-pricing disclosure and the `pricing` option documented in both READMEs, plus `update --force`.

## [0.1.2] - 2026-08-28

### Added

- Reasoning effort variants: the plugin exposes `effort` variants for reasoning models through `toModelV2`.

### Fixed

- Tagged models keep their own specs. The updater now parses per-tag library cards instead of relying on the family card.
- Thinking replay. Conversations pass ollama's `reasoning` wire field back on later turns, so chain-of-thought from an earlier response reaches the next request intact.

### CI

- npm publishes now go through trusted publishing (OIDC), no npm token stored.

## [0.1.1] - 2026-08-27

### Fixed

- The npm plugin now loads. It declares `main` and `./server` exports, which opencode needs to resolve the package.
- Catalog validation got tighter: refreshes validate before publish, and a failed scrape aborts the update instead of publishing a degraded catalog.

### Changed

- Shared provider config extracted in one place; model mapping got simpler.

### CI

- `update-catalog` runs on a self-hosted runner pool and is dispatched from the runner's crontab (GitHub's `schedule` trigger silently drops runs under load), with a keepalive workflow on top.
- `actions/checkout` pinned to v5 (node24 runtime).

## [0.1.0] - 2026-08-27

### Added

- First release. The plugin serves Ollama Cloud models to opencode from `catalog/catalog.json`.
- Catalog updater: scrapes `ollama.com/library/<base>` (~15 requests per run), seeds missing fields from models.dev, writes `catalog/catalog.json`. A failed scrape aborts rather than degrading data.
- README in English and Spanish.
- CI refreshes the catalog on a schedule and verifies the catalog before publishing.

[Unreleased]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/srnoob2570/opencode-ollama-cloud/releases/tag/v0.1.0