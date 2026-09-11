# Repository Atlas: opencode-ollama-cloud

## Project Responsibility

An [opencode](https://opencode.ai) plugin (Bun + TypeScript, no bundler — the host loads the TS/TSX directly) that registers the **Ollama Cloud** provider with an always-current model list. The list is consumed as a static artifact (`catalog.json`) built upstream by [ollama-cloud-catalog](https://github.com/srnoob2570/ollama-cloud-catalog) (hash-gated GitHub Actions, models.dev-shape + `x_ollama` extension). A second, TUI-side plugin entry adds client-side streaming metrics (TTFT / tokens-per-second per LLM step), a live status line, `/stats`, `/model`, and a model card. Official per-model pricing ships embedded in the artifact's `cost` blocks and feeds opencode's cost counter. Both entries are dual V1/V2: opencode 1.x calls `server()`/`tui()`, opencode 2.x reads `id` + `setup()`.

## System Entry Points

- `plugin/index.ts` — dual server plugin entry (`main` / exports `.` and `./server`): V1 factory (`server()`) with hook-based provider registration (`config`), live model list (`provider.models`), and wire stats capture (`event` + fetch wrapper); V2 `setup()` (`v2-server.ts`) applies the artifact through catalog transforms and captures stats from the event stream.
- `plugin/tui.tsx` — dual TUI plugin entry (exports `./tui`): V1 `/stats` and `/model` commands plus the live status-line slot (loaded by opencode 1.x from `tui.json` as a separate module); V2 `setup()` (`tui-v2.tsx`) registers the same UI through the V2 slot/keymap/dialog APIs, auto-loaded from the package's `./tui` export.
- `package.json` — dependency manifest, dual entry points, `test`/`typecheck` scripts.
- `tsconfig.json` — strict TS config (path-less, runtime TS loading by opencode).

## Repository Directory Map (Aggregated)

| Directory | Responsibility Summary                                                                                                                                                                                                                                                          | Detailed Map                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `plugin/` | Plugin core: catalog mirror-race loader + validation adapter, V1 model normalizer (ModelV2) and V2 catalog transform adapter, V1 wire stats capture + V2 event-route capture, handoff persistence, self-update, TUI config patching, V1 and V2 TUI entries, display formatting. | [View Map](plugin/codemap.md) |

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
