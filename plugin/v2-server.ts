// opencode 2.x server plugin: catalog enrichment + stats capture. Kept out of
// ./index.ts so the V1 factory there stays untouched and the V2 wiring stays
// unit-adjacent (./v2-catalog.ts, ./v2-capture.ts).
//
// V2 replaces the V1 seams:
// - `config` + `provider.models`  →  `catalog.transform` (upsert models,
//   enforce our pricing contract; the models.dev provider identity is kept);
// - provider `options.fetch` wire capture  →  the public event stream
//   (`session.step.*`); the beta's session HTTP hooks are not dispatched in
//   0.0.0-beta-19425 (verified empirically), see ./v2-capture.ts;
// - `ensureTuiPlugin` (tui.json)  →  unnecessary: V2 loads the package's
//   `./tui` export automatically;
// - self-update stays V1-only: V2 owns its npm cache and exposes
//   `opencode2 plugin update`, so evicting the V1 wrapper has no V2 meaning.
import { loadCatalog, type PluginOpts } from "./catalog.ts";
import { statsDebugSinkFor } from "./debug-sink.ts";
import { pricingKnob } from "./tui-display.ts";
import { applyV2Catalog } from "./v2-catalog.ts";
import { createV2StatsCapture } from "./v2-capture.ts";
import type { V2ServerContext } from "./v2-types.ts";

export const V2_PLUGIN_ID = "opencode-ollama-cloud";
/**
 * V1 fetched the artifact on every provider.models call; V2 loads it at setup
 * and replays the catalog transform on a floor. The artifact itself updates
 * on upstream schedules, so an hour keeps a long-running daemon current
 * without hammering the CDN mirrors.
 */
export const CATALOG_REFRESH_MS = 60 * 60 * 1000;

export function createV2ServerPlugin(): {
  id: string;
  setup: (ctx: V2ServerContext) => Promise<() => Promise<void>>;
} {
  return {
    id: V2_PLUGIN_ID,
    async setup(ctx: V2ServerContext) {
      const options = ctx.options ?? {};
      const pricing = pricingKnob(options.pricing);
      const stats = options.stats === "off" ? "off" : "on";
      const opts: PluginOpts = {
        catalogUrl:
          typeof options.catalogUrl === "string"
            ? options.catalogUrl
            : undefined,
        timeoutMs:
          typeof options.timeoutMs === "number" ? options.timeoutMs : undefined,
      };

      // The transform closure reads this binding on every replay, so a reload
      // picks up the freshly fetched artifact.
      let catalog = await loadCatalog(opts);
      const registration = await ctx.catalog.transform((editor) => {
        applyV2Catalog(editor, catalog, pricing);
      });

      const cleanups: Array<() => Promise<void> | void> = [
        () => registration.dispose(),
      ];

      if (stats === "on") {
        const capture = createV2StatsCapture({
          debugSink: statsDebugSinkFor(options.statsDebug),
        });
        const registrations = await capture.attach(ctx);
        cleanups.push(...registrations.map((r) => () => r.dispose()));
      }

      const timer = setInterval(() => {
        void (async () => {
          catalog = await loadCatalog(opts);
          await ctx.catalog.reload();
        })().catch(() => {
          /* refresh is best-effort: the previous catalog stays active */
        });
      }, CATALOG_REFRESH_MS);
      cleanups.push(() => clearInterval(timer));

      return async () => {
        for (const fn of [...cleanups].reverse()) {
          try {
            await fn();
          } catch {
            /* unload is best-effort; the host retires the plugin anyway */
          }
        }
      };
    },
  };
}
