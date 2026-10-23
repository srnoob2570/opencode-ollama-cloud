// opencode 2.x entry: inject the live Ollama Cloud model list into the host
// catalog. That is the plugin's whole job — the provider's models, with the
// official rate in each record. opencode owns stats, the TUI and package
// updates, so none of that is wired here.
//
// Contract: silent degradation — a moved/missing plugin API retires the
// feature, never the host's boot. The transform is registered only after the
// catalog loads, because registering it TAKES OWNERSHIP of the provider's
// model set (models.dev entries stop being merged); on catalog failure nothing
// is registered and the host's models.dev fallback stays alive.
import { loadCatalog, PROVIDER_ID, type PluginOpts } from "./catalog.ts";
import { toModelRecord, type ModelRecord } from "./models.ts";

/** The slice of the opencode 2.x PluginContext this module touches. */
interface PluginContext {
  options?: Record<string, unknown>;
  provider?: {
    transform?: (cb: (draft: ProviderDraft) => unknown) => unknown;
  };
}

/** The slice of the provider draft the transform receives. */
export interface ProviderDraft {
  get?: (id: string) => { provider?: unknown } | null | undefined;
  models?: {
    set?: (providerID: string, models: ModelRecord[]) => unknown;
  };
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

/** Pricing knob: the official rate is the default, only "off" disables it.
 * Legacy `"reference"` configs (the old opt-in) stay on. */
export const pricingKnob = (value: unknown): "off" | "on" =>
  value === "off" ? "off" : "on";

/**
 * Transform body, exported for tests: set() on a provider the catalog doesn't
 * know would be a silent no-op at best, so only inject when the provider
 * record exists (it comes from models.dev today; a missing one is the host's
 * problem). A throw here must never break the host's boot.
 */
export function applyModels(
  draft: ProviderDraft | null | undefined,
  records: ModelRecord[],
): void {
  try {
    if (typeof draft?.get !== "function") return;
    if (!draft.get(PROVIDER_ID)) return;
    draft.models?.set?.(PROVIDER_ID, records);
  } catch {
    /* one bad transform call must never break the host's boot */
  }
}

async function setup(ctx: unknown): Promise<void> {
  try {
    const c = ctx as PluginContext | null | undefined;
    const registerTransform = c?.provider?.transform;
    if (typeof registerTransform !== "function") {
      // the runtime moved on again: nothing to register through
      return;
    }
    const options = (c?.options ?? {}) as Record<string, unknown>;
    const pricing = pricingKnob(options.pricing);
    const opts: PluginOpts = {
      catalogUrl: asString(options.catalogUrl),
      timeoutMs: asNumber(options.timeoutMs),
    };

    const models = await loadCatalog(opts);
    if (!models || models.length === 0) return;
    const records = models.map((m) => toModelRecord(m, pricing));

    // the transform runs several times per boot: the records are already
    // mapped once here, so each invocation is just the set() call
    registerTransform((draft: ProviderDraft) => applyModels(draft, records));
  } catch {
    /* silent degradation: a host must still boot the plugin cleanly */
  }
}

export default {
  id: "opencode-ollama-cloud",
  setup,
};
