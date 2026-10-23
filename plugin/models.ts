import { PROVIDER_ID, type CatalogModel } from "./catalog.ts";

// Catalog models without a rate share the zero-cost shape (USD per 1M
// tokens). Factory, not constant: a shared mutable object would alias every
// model's cost.
export const zeroCost = () => ({
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
});

/** A model record accepted by the opencode 2.x catalog (draft.models.set).
 * Loose on purpose: the authoritative contract is the host's runtime schema,
 * verified against opencode 2.0.15 (docs/research/soporte-v1-v2.md). Key
 * traits: cost is an ARRAY of tiers, release date is epoch MS under
 * `time.released`, and effort variants are an array. */
export interface ModelRecord {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  package: string;
  settings: Record<string, unknown>;
  capabilities: {
    tools: boolean;
    input: string[];
    output: string[];
  };
  cost: Array<{
    input: number;
    output: number;
    cache: { read: number; write: number };
  }>;
  status: string;
  enabled: boolean;
  limit: { context: number; output: number };
  compatibility?: { reasoningField: string };
  time?: { released: number };
  variants?: Array<{ id: string; settings: Record<string, unknown> }>;
}

/** The opencode 2.x runtime provider package for the OpenAI-compatible API. */
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";

export function toModelRecord(
  m: CatalogModel,
  pricing: "off" | "on" = "on",
): ModelRecord {
  const vision = m.capabilities.vision;
  const reasoning = m.capabilities.thinking;
  // The official Ollama Cloud rate (off-peak, USD per 1M tokens) rides in the
  // catalog and is opt-out; a model without a cost block stays at $0 in both
  // modes. The 2.x schema wants the tier as the sole array element.
  const official = pricing === "on" ? m.cost : undefined;
  const released = Date.parse(m.releaseDate);
  const record: ModelRecord = {
    id: m.id,
    modelID: m.id,
    providerID: PROVIDER_ID,
    name: m.name,
    package: PROVIDER_PACKAGE,
    // model settings merge over the provider record's own settings (baseURL
    // etc. come from the host's provider entry) — naming the provider is what
    // the runtime's openai-compatible package expects.
    settings: { provider: PROVIDER_ID },
    capabilities: {
      tools: m.capabilities.tools,
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    cost: [
      official
        ? {
            input: official.input,
            output: official.output,
            cache: { read: official.cachedInput ?? 0, write: 0 },
          }
        : { ...zeroCost() },
    ],
    status: "active",
    enabled: true,
    limit: { context: m.context, output: m.maxOutput },
  };
  // ollama's OpenAI-compatible endpoint reads prior-turn assistant thinking
  // from each message's `reasoning` field, not the `reasoning_content` field
  // the AI SDK sends by default.
  if (reasoning) record.compatibility = { reasoningField: "reasoning" };
  // a malformed date must never poison the record: omit the whole `time`
  // block rather than emit NaN into the host schema
  if (Number.isFinite(released)) record.time = { released };
  // effort variants: [{id, {reasoningEffort}}] — ollama.com/v1 maps
  // reasoning_effort (low|medium|high|max) to its native think level
  if (m.reasoningOptions.length > 0)
    record.variants = m.reasoningOptions.map((effort) => ({
      id: effort,
      settings: { reasoningEffort: effort },
    }));
  return record;
}
