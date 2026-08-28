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

## Development

```bash
bun install
bun run check      # did the model list change? (no scraping)
bun run update     # regenerate catalog/catalog.json if it changed
bun run typecheck
```

## License

MIT