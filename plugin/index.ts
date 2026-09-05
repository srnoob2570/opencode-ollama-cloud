import type { Plugin } from "@opencode-ai/plugin";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import {
  PROVIDER_CONFIG,
  PROVIDER_ID,
  loadCatalog,
  loadPricing,
  type PluginOpts,
} from "./catalog.ts";
import { createStatsCapture, type FetchLike } from "./capture.ts";
import { statsDebugSinkFor } from "./debug-sink.ts";
import { toModelV2, zeroCost } from "./models.ts";
import { ensureKnob, ensureTuiPlugin } from "./ensure-tui.ts";
import { runSelfUpdate } from "./self-update.ts";
import { pricingKnob } from "./tui-display.ts";

// NOTE: export ONLY the plugin factory from this entry module. opencode's
// legacy plugin path (packages/opencode/src/plugin/index.ts, getLegacyPlugins)
// calls EVERY exported function of a plugin module as a plugin factory with
// (PluginInput, options) whenever the default export is a function. Any extra
// export here either crashes the whole load (createStatsDebugSink once
// received the PluginInput object as `dir` and threw inside node:path join,
// killing the plugin before `default` ever ran) or throws after registration
// (the old toModelV2 error). toModelV2/zeroCost live in ./models.ts and the
// statsDebug sink in ./debug-sink.ts — import them from there.

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
      ? { event: ({ event }: { event: unknown }) => capture.handleEvent(event) }
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
          // The official-rate table rides the same mirrors as the catalog and
          // joins by id; a missing or partial table just leaves those models
          // at $0 — never a wrong price. With the knob off the table is
          // never fetched: the opt-out costs zero requests, like stats: off.
          const [catalog, rates] = await Promise.all([
            loadCatalog(opts),
            pricing === "on" ? loadPricing(opts) : Promise.resolve(null),
          ]);
          if (catalog) {
            // Entries were already validated by isCatalog in loadCatalog/readCache.
            const models: Record<string, ModelV2> = {};
            for (const m of catalog.models)
              models[m.id] = toModelV2(m, pricing, rates?.[m.id]);
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

export default opencodeOllamaCloud;
