import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import { PROVIDER_ID, type CatalogModel } from "./catalog.ts";

// Split out of index.ts: the plugin entry module must export ONLY the plugin
// factory. opencode's legacy plugin loader calls every exported function of a
// plugin module as a plugin factory with (PluginInput, options) — see the
// note in ./index.ts.

// Catalog models without a rate in the pricing table and the models.dev
// passthrough share the zero-cost shape (opencode's CostV2, USD per 1M
// tokens). Factory, not constant: a shared mutable object would alias every
// model's cost.
export const zeroCost = () => ({
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
});

const MODEL_OUTPUT_CAPS = {
  text: true,
  audio: false,
  image: false,
  video: false,
  pdf: false,
} as const;

// opencode takes plugin-returned models verbatim (no ProviderTransform pass), so
// the effort tiers the TUI rotates between only exist if we emit them ourselves.
// { reasoningEffort } is the payload opencode computes for @ai-sdk/openai-compatible,
// and ollama.com/v1 maps reasoning_effort (low|medium|high|max) to its native think level.
export function toModelV2(
  m: CatalogModel,
  pricing: "off" | "on" = "on",
): ModelV2 {
  const vision = m.capabilities.vision || m.input.includes("image");
  const reasoning = m.capabilities.thinking;
  // prices are USD per 1M tokens — opencode's CostV2 contract. The official
  // Ollama Cloud rate is opt-out: default on, `pricing: "off"` keeps the
  // counter at $0.00. A model without a cost entry (third-party catalogs)
  // stays at $0 in both modes (no partial estimates). cachedInput feeds
  // cache.read; cache.write stays 0 — the rate card publishes no cache-write
  // column.
  const official = pricing === "on" ? m.cost : undefined;
  return {
    id: m.id,
    providerID: PROVIDER_ID,
    api: {
      id: m.id,
      url: "https://ollama.com/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: m.name,
    family: m.family,
    capabilities: {
      temperature: true,
      reasoning,
      attachment: vision,
      toolcall: m.capabilities.tools,
      // ollama's OpenAI-compatible endpoint reads prior-turn assistant
      // thinking from each message's `reasoning` field (openai.go: Thinking:
      // msg.Reasoning), not the `reasoning_content` field the AI SDK sends by
      // default. Naming the field is what makes opencode route stored
      // reasoning parts into a format ollama actually parses back in.
      interleaved: reasoning ? { field: "reasoning" } : false,
      input: {
        text: true,
        audio: false,
        image: vision,
        video: false,
        pdf: false,
      },
      output: MODEL_OUTPUT_CAPS,
    },
    cost: official
      ? {
          ...zeroCost(),
          input: official.input,
          output: official.output,
          cache: {
            read: official.cachedInput ?? 0,
            write: 0,
          },
        }
      : zeroCost(),
    limit: {
      context: m.context,
      output: m.maxOutput,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: m.releaseDate,
    variants: Object.fromEntries(
      // the loader's adapter already dropped non-string entries (isCatalog
      // checks the array shape only), so every key here is a valid effort
      m.reasoningOptions.map((effort) => [effort, { reasoningEffort: effort }]),
    ),
  };
}

// ---- opencode V2 (2.x) model records ---------------------------------------
// The v2 runtime catalog validates a DIFFERENT shape than the v1 SDK Model:
// verified against opencode 2.0.15 via provider.transform/draft.models.set
// (docs/research/soporte-v1-v2.md). Key deltas vs toModelV2: cost is an ARRAY of
// tiers, release date is epoch MS under `time.released` (not ISO under
// `release_date`), effort variants are an ARRAY, and the provider package
// is the runtime's "@opencode/ai/providers/openai-compatible". No published
// types cover this surface (the @opencode-ai/plugin v2 typings ship an
// older generation), so the record is typed loosely here and validated by
// the host schema at runtime.

/** A model record accepted by the v2 catalog (draft.models.set). Loose on
 * purpose: the authoritative contract is the host's runtime schema. */
export interface ModelV2Info {
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

/** The v2 runtime provider package for the OpenAI-compatible API. */
const V2_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";

export function toModelV2Info(
  m: CatalogModel,
  pricing: "off" | "on" = "on",
): ModelV2Info {
  const vision = m.capabilities.vision || m.input.includes("image");
  const reasoning = m.capabilities.thinking;
  // Same pricing contract as toModelV2: the official Ollama Cloud rate
  // (off-peak, USD per 1M tokens) rides in the catalog and is opt-out; a
  // model without a cost block stays at $0 in both modes. The v2 schema
  // wants the tier as the sole array element.
  const official = pricing === "on" ? m.cost : undefined;
  const released = Date.parse(m.releaseDate);
  const record: ModelV2Info = {
    id: m.id,
    modelID: m.id,
    providerID: PROVIDER_ID,
    name: m.name,
    package: V2_PROVIDER_PACKAGE,
    // model settings merge over the provider record's own settings (baseURL
    // etc. come from the host's provider entry) — naming the provider is
    // what the runtime's openai-compatible package expects.
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
  // from each message's `reasoning` field (same finding as the v1
  // `interleaved` mapping — see toModelV2).
  if (reasoning) record.compatibility = { reasoningField: "reasoning" };
  // a malformed date must never poison the record: omit the whole `time`
  // block rather than emit NaN into the host schema
  if (Number.isFinite(released)) record.time = { released };
  // the v2 variant list replaces the v1 effort map: [{id, {reasoningEffort}}]
  if (m.reasoningOptions.length > 0)
    record.variants = m.reasoningOptions.map((effort) => ({
      id: effort,
      settings: { reasoningEffort: effort },
    }));
  return record;
}
