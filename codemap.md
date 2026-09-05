# Repository Atlas: opencode-ollama-cloud

## Project Responsibility

An [opencode](https://opencode.ai) plugin (Bun + TypeScript, no bundler — the host loads the TS/TSX directly) that registers the **Ollama Cloud** provider with an always-current model list. The list is consumed as a static artifact (`catalog.json`) built upstream by [ollama-cloud-catalog](https://github.com/srnoob2570/ollama-cloud-catalog) (hash-gated GitHub Actions, models.dev-shape + `x_ollama` extension). A second, TUI-side plugin entry adds client-side streaming metrics (TTFT / tokens-per-second per LLM step), a live status line, `/stats`, `/model`, and a model card. Official per-model pricing ships embedded in the artifact's `cost` blocks and feeds opencode's cost counter.

## System Entry Points

- `plugin/index.ts` — server plugin entry (`main` / exports `.` and `./server`): hook-based registration of the provider (`config`), live model list (`provider.models`), and stats capture (`event` + fetch wrapper).
- `plugin/tui.tsx` — TUI plugin entry (exports `./tui`): `/stats` and `/model` commands, live status-line slot, loaded by opencode's TUI host from `tui.json` as a separate module.
- `package.json` — dependency manifest, dual entry points, `test`/`typecheck` scripts.
- `tsconfig.json` — strict TS config (path-less, runtime TS loading by opencode).

## Repository Directory Map (Aggregated)

| Directory | Responsibility Summary                                                                                                                                                                                                           | Detailed Map                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `plugin/` | Plugin core: catalog mirror-race loader + validation adapter, model normalizer (ModelV2), streaming stats pipeline (wire capture → measurement → handoff persistence), self-update, TUI config patching, TUI display formatting. | [View Map](plugin/codemap.md) |

## Root Assets

- `plugin/codemap.md` — detailed per-module map (server-side vs TUI-side split, data flow, integration contract).
- `CONTEXT.md` — domain vocabulary (family, LLM step, TTFT/TPS, model card, quantization terms).
- `README.md` / `README.es.md` — user-facing docs (install, options, stats, quantization disclosure).
- `CHANGELOG.md` — per-release changes; release branches under `release/v*`.
- `.pre-commit-config.yaml` — prettier + end-of-file hooks + `tsc --noEmit` gate.
- `research/`, `wayfinder/`, `.scratch/`, `docs/` — local specs, maps, and images (gitignored or non-code; not part of the build).

## Build / Verify Commands

- `bun install` — sync deps (Bun is the sole package manager).
- `bun test` — test suite (fixtures inline; no network).
- `bun run typecheck` — `tsc --noEmit`.

## Cross-References

- Upstream artifact pipeline: `srnoob2570/ollama-cloud-catalog` (workflows `update-catalog` hash-gated, `update-pricing` weekly, `update-capabilities` manual `--force`).
- Consumption chain: jsDelivr → raw.githubusercontent.com → `~/.cache/opencode-ollama-cloud/catalog.json` → models.dev passthrough (zero-cost) — see [plugin/codemap.md Flow](plugin/codemap.md).
