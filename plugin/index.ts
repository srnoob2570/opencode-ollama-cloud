import type { Plugin } from "@opencode-ai/plugin";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import {
  PROVIDER_CONFIG,
  PROVIDER_ID,
  loadCatalog,
  type PluginOpts,
} from "./catalog.ts";
import { createStatsCapture, type FetchLike } from "./capture.ts";
import { statsDebugSinkFor } from "./debug-sink.ts";
import { toModelV2, zeroCost } from "./models.ts";
import { ensureKnob, ensureTuiPlugin } from "./ensure-tui.ts";
import { runSelfUpdate } from "./self-update.ts";
import { pricingKnob } from "./tui-display.ts";
import { setupV2 } from "./server-v2.ts";
import { logDeprecatedV1 } from "./version.ts";

// NOTE: export ONLY the dual entry shape from this module. opencode's legacy
// plugin path (packages/opencode/src/plugin/index.ts, getLegacyPlugins) calls
// EVERY exported function of a plugin module as a plugin factory with
// (PluginInput, options) whenever the default export is a function — the dual
// object default below is its PluginModule shape, so v1 reads `.server` and
// v2 validates `id + setup`. Either way, an extra exported function here is
// still fair game as a factory on v1: one once crashed the whole load
// (createStatsDebugSink received the PluginInput object as `dir` and threw
// inside node:path join, killing the plugin before `default` ever ran) and
// another threw after registration (the old toModelV2 error).
// toModelV2/zeroCost live in ./models.ts and the statsDebug sink in
// ./debug-sink.ts — import them from there.

// Pricing knob (opt-out): default on — the rate is the OFFICIAL Ollama Cloud
// tariff (the public rate card), so only `off` turns it off. Legacy configs
// saying "reference" (the old opt-in) keep pricing on, never accidentally off.
const opencodeOllamaCloud: Plugin = async (input, options) => {
  const pricing: "off" | "on" = pricingKnob(options?.pricing);
  // Stats knob (ticket 08): default ON — opt-out, the mirror of pricing. In
  // "off" the plugin behaves exactly as before the stats effort: no fetch
  // wrap, no event sink, no handoff, zero overhead.
  const stats: "on" | "off" = options?.stats === "off" ? "off" : "on";
  const opts: PluginOpts = {
    catalogUrl:
      typeof options?.catalogUrl === "string" ? options.catalogUrl : undefined,
    timeoutMs:
      typeof options?.timeoutMs === "number" ? options.timeoutMs : undefined,
  };

  // V1 deprecation notice (owner decision: silent — one line in the plugin's
  // own debug log, never on screen). This factory only runs on opencode 1.x
  // hosts, so no version detection is needed — presence here means v1.
  logDeprecatedV1(options?.deprecation);

  const { id: _id, ...providerConfig } = PROVIDER_CONFIG;
  // Stats capture (spec Pieza 1): wire wrapper for ollama-cloud + claim
  // correlation sink. All failure paths live inside the capture; nothing here
  // may throw. In "off" mode the capture is never created and the hooks below
  // simply leave the plugin as it was before the stats effort.
  const capture =
    stats === "on"
      ? createStatsCapture({
          debugSink: statsDebugSinkFor(options?.statsDebug),
        })
      : null;

  // Self-update check (precedent: @tarquinen/opencode-dcp): fire-and-forget on
  // every boot, independent of the stats knob — it is plugin infrastructure,
  // not stats. runSelfUpdate never throws and no-ops (clearing a stale
  // update.json) when the plugin runs from the repo (dev install).
  void runSelfUpdate({ moduleUrl: import.meta.url, client: input.client });

  // Opt-in TUI registration (tui: "ensure"): the TUI host only reads its
  // plugin list from tui.json and nothing upstream writes it for an npm
  // install, so with the knob on the server entry — which always loads —
  // registers the TUI entry itself. Idempotent, comment-preserving, dev is a
  // no-op; the change takes effect on the next TUI launch.
  if (ensureKnob(options?.tui) === "ensure")
    void ensureTuiPlugin({ moduleUrl: import.meta.url });

  return {
    ...(capture
      ? {
          event: ({ event }: { event: unknown }) => capture.handleEvent(event),
        }
      : {}),
    config: async (cfg) => {
      cfg.provider ??= {};
      const provider = (cfg.provider[PROVIDER_ID] ??= { ...providerConfig });
      if (!capture) return;
      // opencode honors a provider `options.fetch` (its seam wraps it with
      // timeouts and passes the signal through). We wrap AROUND any existing
      // custom fetch (proxy/CA/agent) instead of clobbering it — only SSE
      // chat calls get measured, everything else flows through untouched.
      const providerWithOptions = provider as {
        options?: Record<string, unknown>;
      };
      const userFetch = (providerWithOptions.options?.fetch ??
        null) as FetchLike | null;
      providerWithOptions.options = {
        ...providerWithOptions.options,
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          capture.wireFetch(input, init, userFetch ?? undefined),
      };
    },
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => {
        try {
          // The official rate lives INSIDE the catalog (each entry's cost
          // block, off-peak): one fetch, one contract. A missing or partial
          // cost block just leaves those models at $0 — never a wrong price.
          // With the knob off the counter is zeroed downstream, at no extra
          // fetch cost (the catalog is the provider source either way).
          const catalog = await loadCatalog(opts);
          if (catalog) {
            // Entries were already validated and normalized by loadCatalog.
            const models: Record<string, ModelV2> = {};
            for (const m of catalog.models)
              models[m.id] = toModelV2(m, pricing);
            if (Object.keys(models).length > 0) return models;
          }
          console.warn(
            "[opencode-ollama-cloud] no usable catalog, falling back to models.dev models",
          );
        } catch (err) {
          console.warn(
            "[opencode-ollama-cloud] catalog load failed, falling back to models.dev models:",
            err,
          );
        }
        // Passthrough: models.dev's ollama-cloud entries carry no cost today,
        // but the official-rate contract holds regardless — a model without
        // OUR pricing table never shows a cost, even if models.dev attaches
        // one later (cost here means the Ollama Cloud rate, not their number).
        const models: Record<string, ModelV2> = {};
        for (const [id, model] of Object.entries(provider.models))
          models[id] = { ...model, cost: zeroCost() };
        return models;
      },
    },
  };
};

// Dual-host entry (docs/research/soporte-v1-v2.md): opencode v1 reads `.server`
// from an object default (its PluginModule shape — same as @opencode-ai/plugin
// documents and as @tarquinen/opencode-dcp ships), while v2 validates
// `id + setup` and runs setup(ctx) with the v2 PluginContext, ignoring
// `.server`. One module, both hosts; which code runs IS the generation.
export default {
  id: "opencode-ollama-cloud",
  setup: setupV2,
  server: opencodeOllamaCloud,
};
