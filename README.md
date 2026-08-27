# @srnoob2570/opencode-ollama-cloud

[Leer en español →](README.es.md)

[opencode](https://opencode.ai) plugin that registers the **Ollama Cloud** provider with an always-up-to-date model list, sourced from `https://ollama.com/v1/models`.

models.dev (opencode's model source) is updated manually via PRs and goes stale. This plugin consumes a static catalog maintained by GitHub Actions: the workflow compares the live `/v1/models` list against the committed catalog and only scrapes + commits when the list actually changes.

## How it works

```
ollama.com/v1/models ──┐
                       ├─→ GitHub Action (every 15min) ─→ catalog/catalog.json (auto-commit)
ollama.com/library/* ──┘

catalog.json (jsDelivr, purged after each commit / raw.githubusercontent / local cache) ─→ plugin ─→ opencode
```

**Action** (`.github/workflows/update.yml`): runs `bun scripts/update-catalog.ts update` on a 15-minute cron (cheap: the `check` is a single GET to `/v1/models`; scraping only happens when the list changed). Worst-case staleness ≈ 15 min + CDN propagation.

- `check`: compares the hash of `{id, created}` from `/v1/models` against the committed catalog. No scraping.
- `update`: if the hash changed, scrapes `ollama.com/library/<base>` (1 request per family, ~15 requests), enriches with data seeded from models.dev (max output tokens, release dates), and writes `catalog/catalog.json`. If nothing changed, it touches nothing.

**Plugin** (`plugin/index.ts`): a `config` hook registers the provider (idempotent) and a `provider` hook returns the models normalized to opencode's schema, with a fallback cascade:

1. Remote catalog (jsDelivr → raw.githubusercontent.com)
2. Local cache at `~/.cache/opencode-ollama-cloud/catalog.json`
3. models.dev passthrough (the models opencode already ships)

## Installation

### From npm (once published)

```bash
opencode auth login
# pick ollama-cloud and paste your ollama.com API key

opencode install @srnoob2570/opencode-ollama-cloud
```

Or add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@srnoob2570/opencode-ollama-cloud"]
}
```

### Local (from this repo)

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

## Usage

Restart opencode and verify:

```bash
opencode models
```

You should see `ollama-cloud/<model>` with the live list (including fresh models like `glm-5.3-flash` that models.dev doesn't have yet).

## Development

```bash
bun install
bun run check      # did the model list change? (no scraping)
bun run update     # regenerate catalog/catalog.json if it changed
bun run typecheck
```

## License

MIT