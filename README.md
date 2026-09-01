# @srnoob2570/opencode-ollama-cloud

[![npm](https://img.shields.io/npm/v/@srnoob2570/opencode-ollama-cloud)](https://www.npmjs.com/package/@srnoob2570/opencode-ollama-cloud)
[![Catalog update](https://github.com/srnoob2570/opencode-ollama-cloud/actions/workflows/update.yml/badge.svg)](https://github.com/srnoob2570/opencode-ollama-cloud/actions/workflows/update.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Leer en español →](README.es.md)

[opencode](https://opencode.ai) plugin that registers the **Ollama Cloud** provider with an always-up-to-date model list, sourced live from `https://ollama.com/v1/models`.

models.dev (opencode's model source) is updated manually via PRs and goes stale. This plugin consumes a static catalog maintained by GitHub Actions, so new models appear without waiting for anyone.

> [!NOTE]
> **Transparency:** this plugin, its catalog updater, and this documentation were generated and are maintained with AI assistance ([opencode](https://opencode.ai)). Review the code before trusting it with anything sensitive.

## Quick start

```bash
opencode plugin @srnoob2570/opencode-ollama-cloud --force --global
```

`--force` replaces an already-installed version — opencode has no plugin update command, so re-running this command is how you upgrade. `--global` installs into `~/.config/opencode/opencode.json` instead of a project-local config.

That's it. Restart opencode and check:

```bash
opencode models ollama-cloud --refresh
```

You should see the full live list (e.g. `ollama-cloud/glm-5.3-flash`), including models models.dev doesn't have yet.

> Assumes you already configured your ollama.com API key (`opencode auth login` → `ollama-cloud`). If the provider was already registered, the plugin just refreshes its model list.

## How it works

```
ollama.com/v1/models ──┐
                       ├─→ GitHub Action (every 15 min) ─→ catalog/catalog.json (auto-commit)
ollama.com/library/* ──┘

catalog.json (jsDelivr, purged after each commit / raw.githubusercontent / local cache) ─→ plugin ─→ opencode
```

**Action** (`.github/workflows/update.yml`): runs `bun scripts/update-catalog.ts update` on a 15-minute cron. Cheap by design — the check is a single GET to `/v1/models`; scraping only happens when the list changed (or once a week, to refresh enrichment data). The updated catalog is validated (`bun scripts/validate-catalog.ts`) before anything is committed. Worst-case staleness ≈ 15 min + CDN propagation.

- `check`: compares the hash of `{id, created}` from `/v1/models` against the committed catalog. No scraping.
- `update`: if the hash changed (or the catalog is older than 7 days), scrapes `ollama.com/library/<base>` (1 request per family, ~15 requests), enriches with data seeded from models.dev (max output tokens, release dates), and writes `catalog/catalog.json`. If nothing changed, it touches nothing. If a scrape fails and there's no previous data to keep, the update aborts instead of publishing a degraded catalog.
- `validate`: structural + sanity gate for `catalog/catalog.json` (used by CI; run it locally after hand-editing).

**Plugin** (`plugin/index.ts`): a `config` hook registers the provider (idempotent) and a `provider` hook returns the models normalized to opencode's schema, with a fallback cascade:

1. Remote catalog (jsDelivr → raw.githubusercontent.com)
2. Local cache at `~/.cache/opencode-ollama-cloud/catalog.json`
3. models.dev passthrough (the models opencode already ships)

## Manual install

Prefer editing the config yourself? Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@srnoob2570/opencode-ollama-cloud"]
}
```

### Local (from a clone of this repo)

```json
{
  "plugin": ["/path/to/opencode-ollama-cloud/plugin/index.ts"]
}
```

### Options

```json
{
  "plugin": [["@srnoob2570/opencode-ollama-cloud", { "catalogUrl": "https://my-cdn/catalog.json" }]]
}
```

- `catalogUrl`: alternative catalog URL (tried first).
- `timeoutMs`: per-fetch timeout (default `5000`).
- `pricing`: `"off"` (default) or `"reference"` — whether opencode's session cost counter shows the catalog's reference prices.

```json
{
  "plugin": [["@srnoob2570/opencode-ollama-cloud", { "pricing": "reference" }]]
}
```

The catalog ships a **reference price** per model — the upstream API rate in USD per 1M tokens, built automatically from models.dev first-party entries and correctable in `catalog/pricing-overrides.json` (overrides win; disagreements with the seed are recorded in the catalog's `conflicts`). These are reference prices, **not billing**: your ollama.com plan doesn't charge per use, and the real token rate is only visible in your ollama.com panel. Models without pricing data stay at $0 (no partial estimates).

## Streaming stats and the model card

The plugin measures what opencode doesn't: **TTFT** (time to first token) and **tokens/s** of every LLM step, client-side — wire-accurate for `ollama-cloud` (the plugin wraps the provider's `fetch` and reads the final `usage` chunk opencode already requests), event-derived for any other provider. It shows a live session average — **the metrics belong to the session, not the current model** (no per-model breakdown, no reset when you switch models) — next to the token counter:

```
12.4k tokens (23%) · $0.02 · 38.2 tok/s · TTFT 380 ms · Session average
```

- `/stats` — session summary plus the latest responses (step-level detail; `wire` vs `event` rows are distinguishable).
- `/model` — model card of the active model: quantization, family, capabilities, limits, release date and the reference price (when `pricing: "reference"`).

The average only counts the **main conversation**: subagents, title generation and compaction never enter it (measured signals verified against opencode's source). Numbers are in-memory per session — nothing is stored, and nothing is sent anywhere. The stats UI ships as a second plugin entry and degrades silently: on an opencode the TUI API moved in, the provider/catalog keep working and stats simply vanish (tested against opencode **1.18.25**; the plugin API it uses is present-but-undocumented there, so treat stats UI as best-effort until upstream documents it).

```json
{
  "plugin": [
    ["@srnoob2570/opencode-ollama-cloud", { "pricing": "reference" }],
    ["@srnoob2570/opencode-ollama-cloud/tui", {}]
  ]
}
```

- `stats`: `"on"` (default) or `"off"` — set it on **both** entries turns everything off: no measurement, no UI, exactly yesterday's plugin.

### Quantization disclosure

The model card's **quantization** is the value Ollama **declares** for the model it serves (registry `file_type`, cross-checked against `/api/show`), researched per model and carried in the catalog — it does **not** guarantee the precision the remote inference actually runs at. Models without a defensible public source say `unknown` (never guessed), and models outside the catalog show `—`.

Credit where it's due: the streaming-stats idea was proposed by GitHub user **[@adilfaisal01](https://github.com/adilfaisal01)**.

## Development

```bash
bun install
bun run check           # did the model list change? (no scraping)
bun run update          # regenerate catalog/catalog.json if it changed
bun run update --force  # regenerate even when the list is unchanged (new enrichment)
bun run typecheck
```

## Changelog

Every version gets an entry in [CHANGELOG.md](CHANGELOG.md) and its own [GitHub release](https://github.com/srnoob2570/opencode-ollama-cloud/releases). Release branches live under `release/v*`.

## License

MIT