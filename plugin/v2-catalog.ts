// V2 catalog adapter: projects the plugin's normalized artifact models
// (catalog.ts) onto opencode 2.x's catalog editor. Pure by design — the
// transform wiring lives in ./v2-server.ts — so the mapping (limits, cost
// array, reasoning variants, release epoch) is unit-testable without opencode.
//
// Contract parity with the V1 provider hook:
// - the artifact's provider block is NEVER adopted: the models.dev provider
//   identity (package, activation, settings) stays authoritative;
// - pricing rides inside the artifact: with the knob off (or no cost block)
//   the model is rateless ($0), never a partial estimate;
// - models the artifact does not list keep working but stay rateless, so
//   models.dev numbers can never masquerade as the Ollama Cloud rate.
import {
  PROVIDER_CONFIG,
  PROVIDER_ID,
  type Catalog,
  type CatalogModel,
} from "./catalog.ts";
import type {
  V2CatalogEditor,
  V2Cost,
  V2ModelInfo,
  V2Variant,
} from "./v2-types.ts";

/** Zero-cost tier in V2's array shape (USD per 1M tokens). Factory, not
 * constant: every model must own its array. */
export const zeroCostArray = (): V2Cost[] => [
  { input: 0, output: 0, cache: { read: 0, write: 0 } },
];

/** Model.Info.time.released is epoch ms; the artifact publishes an ISO day.
 * Anything unparseable degrades to 0 (the V2 default), never NaN. */
export function releaseMs(releaseDate: string): number {
  const parsed = Date.parse(releaseDate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Fields this adapter owns on a catalog model. */
export interface V2ModelPatch {
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; output: number };
  cost: V2Cost[];
  variants?: V2Variant[];
  released: number;
  status: "active";
}

/** Artifact model → V2 patch. `pricing: "off"` zeroes the counter; a model
 * without a cost block is rateless in both modes (V1 contract). */
export function modelPatch(
  m: CatalogModel,
  pricing: "off" | "on",
): V2ModelPatch {
  const official = pricing === "on" ? m.cost : undefined;
  return {
    name: m.name,
    capabilities: {
      tools: m.capabilities.tools,
      input: [...m.input],
      // V1 hardcoded text-only output caps; V2's capabilities.output is the
      // output modality list, so the same contract is ["text"].
      output: ["text"],
    },
    limit: { context: m.context, output: m.maxOutput },
    cost: official
      ? [
          {
            input: official.input,
            output: official.output,
            cache: { read: official.cachedInput ?? 0, write: 0 },
          },
        ]
      : zeroCostArray(),
    ...(m.reasoningOptions.length > 0
      ? {
          variants: m.reasoningOptions.map((effort) => ({
            id: effort,
            settings: { reasoningEffort: effort },
          })),
        }
      : {}),
    released: releaseMs(m.releaseDate),
    status: "active",
  };
}

/**
 * Upsert variants by id: artifact-declared ids are authoritative for their
 * reasoningEffort setting, while ids the artifact does not declare (user
 * config additions, models.dev entries) survive. Replacing the whole array
 * would silently break `#variant` references configured by the user.
 */
export function mergeVariants(
  existing: readonly V2Variant[],
  additions: readonly V2Variant[],
): V2Variant[] {
  const byId = new Map(existing.map((v) => [v.id, v]));
  for (const add of additions) {
    const prev = byId.get(add.id);
    byId.set(
      add.id,
      prev ? { ...prev, settings: { ...prev.settings, ...add.settings } } : add,
    );
  }
  return [...byId.values()];
}

/** Mutate a catalog model in place (the editor's callback contract). */
export function applyModelPatch(model: V2ModelInfo, patch: V2ModelPatch): void {
  model.name = patch.name;
  model.capabilities ??= { tools: true, input: [], output: [] };
  model.capabilities.tools = patch.capabilities.tools;
  model.capabilities.input = [...patch.capabilities.input];
  model.capabilities.output = [...patch.capabilities.output];
  model.limit ??= { context: 0, output: 0 };
  model.limit.context = patch.limit.context;
  model.limit.output = patch.limit.output;
  model.cost = patch.cost;
  if (patch.variants)
    model.variants = mergeVariants(model.variants ?? [], patch.variants);
  model.time ??= { released: 0 };
  model.time.released = patch.released;
  model.status = patch.status;
}

/**
 * The whole catalog transform body. `catalog === null` means the artifact
 * could not be loaded: every ollama-cloud model is then rateless (the V1
 * models.dev passthrough contract — our rate or nothing).
 */
export function applyV2Catalog(
  editor: V2CatalogEditor,
  catalog: Catalog | null,
  pricing: "off" | "on",
): void {
  const provider = editor.provider.get(PROVIDER_ID);
  if (!provider) {
    // V2 cannot create a provider from scratch: without the models.dev
    // provider block there is nothing to enrich.
    console.warn(
      "[opencode-ollama-cloud] provider ollama-cloud missing from the catalog; V2 enrichment skipped",
    );
    return;
  }

  // Provider identity stays ours (never the artifact's block), mirroring the
  // V1 config hook.
  editor.provider.update(PROVIDER_ID, (p) => {
    p.name = PROVIDER_CONFIG.name;
    p.settings = { ...(p.settings ?? {}), baseURL: PROVIDER_CONFIG.api };
  });

  const artifact = catalog?.models ?? [];
  const artifactIds = new Set(artifact.map((m) => m.id));
  for (const m of artifact) {
    editor.model.update(PROVIDER_ID, m.id, (model) =>
      applyModelPatch(model, modelPatch(m, pricing)),
    );
  }

  // Models outside the artifact stay available (models.dev metadata) but can
  // never display a foreign price as the official rate.
  for (const id of provider.models.keys()) {
    if (artifactIds.has(id)) continue;
    editor.model.update(PROVIDER_ID, id, (model) => {
      model.cost = zeroCostArray();
    });
  }
}
