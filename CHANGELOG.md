# Changelog

Entries here follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html).
Each version also lives on the [releases page](https://github.com/srnoob2570/opencode-ollama-cloud/releases).

## [Unreleased]

## [0.1.5] - 2026-09-01

### Fixed

- The `/stats` and `/model` dialogs render in English now. They shipped with Spanish labels (Sesión, Cuantización, "hace 1m") against an otherwise English TUI; every presented string matches the core UI language. The live line was already English and is unchanged.
- The catalog's provenance strings are English too, and two rows keep their real source on every refresh: glm-5.2 and nemotron-3-ultra have always had an empty registry blob, so their researched implicit provenance (the checkpoint, the library README) no longer degrades to "previous run" with each catalog update.

## [0.1.4] - 2026-09-01

### Added

- Streaming stats, opt-out. The plugin measures TTFT and tokens per second for every LLM step, on your machine. For ollama-cloud it wraps the provider fetch and reads the final usage chunk, so the timing is wire-accurate; for every other provider it estimates from opencode's own events. The line next to the token counter shows the session average, like `38.2 tok/s · TTFT 380 ms · Session average`. Three things to know. It counts only your main conversation, so subagents, title generation and compaction stay out. The average belongs to the session rather than the model. Nothing is stored and nothing leaves your machine. Idea by [@adilfaisal01](https://github.com/adilfaisal01).
- Setup. The stats UI ships as a second plugin entry, `"opencode-ollama-cloud/tui"`. The API it uses exists in opencode 1.18.25 but isn't documented, so treat the UI as best effort; if a future opencode moves that API, the stats simply disappear and the rest of the plugin keeps working. `stats: "off"` on both entries leaves the plugin exactly as before.
- Two dialogs. `/stats` opens the session summary plus the last responses, and you can tell wire measurements apart from the event estimates. `/model` opens the active model's card: quantization, family, capabilities, limits, release date, and the reference price when `pricing: "reference"` is set.
- Quantization. The updater now extracts the value Ollama declares for each model, read from the registry config blob and cross-checked against `/api/show`. Fifteen of the nineteen models come straight from the registry. `glm-5.2` and `nemotron-3-ultra` carry values researched from public sources, with the source noted. `minimax-m3` and `minimax-m2.7` stay `unknown` because the public signals contradict each other or are simply absent. Treat it as declared, not guaranteed. Ollama doesn't document the precision the remote inference actually runs at. The field is optional and has no closed enum, so a new Ollama format can't break the updater.

### Removed

- Type-level break. The unused `pricing` field is gone from the exported `PluginOpts` type. The `pricing` option in your opencode config is unchanged and works the same as before. Only code that sets `pricing` on the internal `PluginOpts` type will fail typecheck.

### Changed

- Internal cleanup. Test fixtures are shared, `family` is now the single vocabulary for model bases, the models.dev seed URL lives in one place, and the updater CLI rejects unknown arguments instead of running a full update on typos.

### CI

- `catalog.json` now validates against the published JSON schema, alongside the hand-mirrored checks, so the two contracts can't drift apart.

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

[Unreleased]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/srnoob2570/opencode-ollama-cloud/releases/tag/v0.1.0