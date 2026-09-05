# Changelog

Entries here follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html).
Each version also lives on the [releases page](https://github.com/srnoob2570/opencode-ollama-cloud/releases).

## [Unreleased]

## [0.1.9] - 2026-09-05

### Added

- The plugin now updates itself, the way `@tarquinen/opencode-dcp` does. On every boot the server entry checks npm once (10 s timeout, a failed check is ignored). When a newer release exists and the plugin came from npm with an unpinned spec, opencode reinstalls the latest on its next start, a toast says "Updated … Restart opencode to finish.", and the stats line shows an `↑ <version>` badge until then. Repo checkouts and pinned specs are never touched. The check runs even with `stats: "off"` because it is plugin infrastructure, not stats.
- `tui: "ensure"` plugin option (off by default). The TUI host of opencode 1.18+ reads its plugin list only from `tui.json`, so an npm install left the stats line dead until a manual edit. With the option on, the server entry registers the TUI entry itself: it patches the tui.json opencode actually reads (`$OPENCODE_TUI_CONFIG` when set, else the global one), adds the spec only when it is missing, keeps comments and existing entries (like `["…", { "stats": "off" }]`) intact, backs up the file and writes it atomically. Dev installs write nothing. The change lands on the next TUI launch. `jsonc-parser` is a new dependency.

### Fixed

- The stats line no longer stays on the dashes placeholder when the TUI starts with no open session (a fresh start, not a restored one). The slot renders once at mount, so the session id used to stay empty for the whole run; the TUI plugin now falls back to `api.route.current` and picks up the session after it opens.

### Changed

- Documentation: `opencode plugin @srnoob2570/opencode-ollama-cloud` is the primary install route (it registers the provider and TUI entries in one command). Manual `tui.json` edits and the new `tui: "ensure"` option are the alternatives.

**Full changelog:** https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.8...v0.1.9

## [0.1.8] - 2026-09-03

### Fixed

- Cancelling a request no longer prints `no usage chunk seen; steps will be dropped (include_usage missing?)`. Aborted and cancelled streams never receive the final usage chunk by design, so they are dropped silently; the one-time hint now fires only when a stream completes naturally without a usage chunk — the actual diagnostic case.

### Changed

- Documentation: the TUI plugin entry must be registered in `tui.json` — since opencode 1.18 the TUI host only loads its plugins from `~/.config/opencode/tui.json` (or the project's), never from the `plugin` array in `opencode.json`. The README examples now show the verified setup (provider entry in `opencode.json`, plain file path for `tui.tsx` in `tui.json`), and the tested version is updated to opencode 1.18.27.

## [0.1.7] - 2026-09-03

### Added

- `update-pricing` GitHub Actions workflow. Refreshing the rate card is now a manual run from the Actions tab (or `gh workflow run update-pricing`): the workflow fetches Ollama's live pricing page, prints every rate that changed, commits the refreshed `catalog/pricing.json` and purges the jsDelivr cache. It never runs on a schedule, and the local `bun run update-pricing` still works the same way.
- `statsDebug` plugin option. When set, the server appends one line per claim attempt (pendings seen, result, per-step source and timestamps) to a bounded `stats-debug.log` in the plugin cache dir, default off — the tool for diagnosing a missing step.

### Fixed

- The plugin could stop loading entirely. opencode's legacy loader calls every exported function of a plugin entry module as a plugin factory, so the new `createStatsDebugSink` export (sorting before `default`) received the loader's input object as its directory argument and crashed the whole load — no hooks, no measurements, dashes forever. The helpers now live in `plugin/models.ts` and `plugin/debug-sink.ts`; the entry module exports only the plugin factory. (The old `toModelV2` export had the same latent bug, harmless only because `default` ran first.)
- Stats timing. A response that took longer than 30 s used to vanish from the session average because the pending window was anchored at request start; it now anchors at stream end. Single-chunk responses (`wire-nostream`) no longer fold the whole wait into the session TPS: decode time is measured from first chunk to stream end, as the metric is defined, and those rows carry a `(direct)` tag in `/stats`. Zero-token steps (`completion_tokens: 0`) are rejected consistently instead of entering the average.
- Cross-session leaks. The handoff is one file per session (`stats-<sessionID>.json`), so a concurrent session can no longer clobber another session's stats, the TUI shows dashes instead of another session's numbers at startup, and stale files older than 24 h plus the legacy single-slot `stats.json` are cleaned up.
- Claim correlation. Pending wire measurements now correlate to their assistant message by time (largest `ts` at or before the message's `time.created`, 2 s tolerance) instead of blind newest-wins, so an early update for an aborted attempt can't count a stale measurement, and an overlapping compaction pending is consumed and dropped.
- `/stats` no longer attributes a mixed-model session average to one model — the header reads `Session · last model <id>` — and the dialog body refreshes every second while it stays open.
- The TUI unsubscribes its event handlers and stops its poll timer on dispose (reload-safe), and refresh errors are reported through opencode's log too, not only the private debug file.

### Changed

- Stats measure ollama-cloud only. The event-based estimation for other providers is retired, together with its `(event)` tag and the untyped runtime fields it relied on; every measured step now comes off the wire. Ratified in the spec (decisions D1–D3, 2026-09-03).
- Token sizes in the `/model` card use the same decimal base (1 000) as the stats instead of binary (1 024).
- Server-side bookkeeping is bounded: at most 500 session collectors and 500 steps per session, with exact running totals so the session summary is unchanged. When the opencode seam stops delivering the session header or the usage chunk, the server logs a one-time warning instead of silently freezing the live line on dashes.

## [0.1.6] - 2026-09-01

### Added

- `bun run update-pricing`. You refresh the pricing table by hand, never on a schedule. The command fetches Ollama's live rate card, prints every rate that changed and rewrites `catalog/pricing.json`. When the page and the catalog disagree, say a model Ollama just added or retired, it stops with a report and writes nothing.
- Pre-commit hooks. Contributors get prettier formatting and a typecheck gate; `pre-commit install` sets them up.

### Changed

- Pricing now shows the official Ollama Cloud rate by default, the number your credits actually pay per million tokens. The rates come from Ollama's public [rate card](https://ollama.com/pricing) and ship in `catalog/pricing.json`. No configuration needed. `pricing: "off"` turns it off; the old `pricing: "reference"` still works and means on.
- The `/model` card lists the three rates: input, cached input and output. Cache reads are priced at the cached-input rate, so sessions with cache hits cost what Ollama actually charges.

### Removed

- The upstream "reference price" and `catalog/pricing-overrides.json`. That estimate existed because Ollama published no rates; with an official rate card there is nothing left to correct. Pricing no longer ships inside `catalog/catalog.json` either. The table is the only home for rates, and the automated catalog update cannot touch it.

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

[Unreleased]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/srnoob2570/opencode-ollama-cloud/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/srnoob2570/opencode-ollama-cloud/releases/tag/v0.1.0
