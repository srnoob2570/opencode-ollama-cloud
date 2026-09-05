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
