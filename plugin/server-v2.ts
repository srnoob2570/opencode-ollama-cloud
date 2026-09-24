// opencode V2 server entry (docs/research/soporte-v1-v2.md). The v2 host never
// runs the v1 `server` factory — it validates `default = {id, setup}` and
// calls setup(ctx) with the v2 PluginContext. This module implements the
// plugin's core value (live catalog + official pricing) through that
// context; everything else the v1 side does is NOT reachable on opencode
// 2.0.x and is deliberately not wired here:
//
//   - stats capture: no fetch seam and no event delivery exist for plugins
//     in 2.0.15 (`ctx.aisdk.hook` / `ctx.event.subscribe` register but never
//     fire — verified empirically), so there is nothing to measure through.
//   - TUI module / ensure-tui / self-update toast+badge: 2.0.x has no
//     third-party TUI plugin loading path, so none of it can take effect;
//     the host's own `opencode plugin update` owns package updates.
//
// Contract: same silent degradation as the TUI module — every surface is
// feature-detected, a moved/missing API retires the feature, never the load.
// No published typings cover the 2.x PluginContext (the @opencode-ai/plugin
// v2 exports describe an older generation), so ctx is typed structurally.
import { loadCatalog, PROVIDER_ID, type PluginOpts } from "./catalog.ts";
import { toModelV2Info, type ModelV2Info } from "./models.ts";
import { pricingKnob } from "./tui-display.ts";

/** The slice of the v2 PluginContext this module touches (research doc). */
interface V2PluginContext {
  options?: Record<string, unknown>;
  provider?: {
    transform?: (cb: (draft: V2ProviderDraft) => unknown) => unknown;
  };
}

interface V2ProviderDraft {
  get?: (id: string) => { provider?: unknown } | null | undefined;
  models?: {
    set?: (providerID: string, models: ModelV2Info[]) => unknown;
  };
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

/**
 * v2 setup: catalog → provider.transform → draft.models.set. The transform
 * registration TAKES OWNERSHIP of the provider's model set (the models.dev
 * entries for ollama-cloud stop being merged once a plugin declares the
 * transform), so it is only registered AFTER the catalog loads with at
 * least one model — on failure the models.dev fallback stays alive, the
 * exact mirror of the v1 factory's fallback contract.
 */
export async function setupV2(ctx: unknown): Promise<void> {
  try {
    const c = ctx as V2PluginContext | null | undefined;
    const registerTransform = c?.provider?.transform;
    if (typeof registerTransform !== "function") {
      // the runtime moved on again: nothing to register through
      return;
    }
    const options = (c?.options ?? {}) as Record<string, unknown>;
    const pricing: "off" | "on" = pricingKnob(options.pricing);
    const opts: PluginOpts = {
      catalogUrl: asString(options.catalogUrl),
      timeoutMs: asNumber(options.timeoutMs),
    };

    const catalog = await loadCatalog(opts);
    if (!catalog || catalog.models.length === 0) {
      // catalog down: DO NOT register the transform (see the ownership note
      // above) — the host keeps its models.dev models for this provider.
      return;
    }
    const records = catalog.models.map((m) => toModelV2Info(m, pricing));

    registerTransform((draft: V2ProviderDraft) => {
      try {
        // set() on a provider the catalog doesn't know would be a silent
        // no-op at best: only inject when the provider record exists (it
        // comes from models.dev today; a missing one is the host's problem).
        if (typeof draft?.get !== "function") return;
        if (!draft.get(PROVIDER_ID)) return;
        draft.models?.set?.(PROVIDER_ID, records);
      } catch {
        /* one bad transform call must never break the host's boot */
      }
    });
  } catch {
    /* silent degradation: a v2 host must still boot the plugin cleanly */
  }
}
