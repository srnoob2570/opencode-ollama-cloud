import type { Plugin } from "@opencode-ai/plugin"
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2"
import {
  PROVIDER_CONFIG,
  PROVIDER_ID,
  loadCatalog,
  type Catalog,
  type CatalogModel,
  type PluginOpts,
} from "./catalog.ts"

const MODEL_OUTPUT_CAPS = {
  text: true,
  audio: false,
  image: false,
  video: false,
  pdf: false,
} as const

// opencode takes plugin-returned models verbatim (no ProviderTransform pass), so
// the effort tiers the TUI rotates between only exist if we emit them ourselves.
// { reasoningEffort } is the payload opencode computes for @ai-sdk/openai-compatible,
// and ollama.com/v1 maps reasoning_effort (low|medium|high|max) to its native think level.
export function toModelV2(m: CatalogModel, pricing: "off" | "reference" = "off"): ModelV2 {
  const vision = m.capabilities.vision || m.input.includes("image")
  const reasoning = m.capabilities.thinking
  // prices are USD per 1M tokens — opencode's CostV2 contract. Reference costs
  // are opt-in: default off keeps the counter at $0.00, and a model without
  // pricing data stays at $0 in both modes (no partial estimates).
  const ref = pricing === "reference" ? m.pricing : undefined
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
    cost: {
      input: ref ? ref.input : 0,
      output: ref ? ref.output : 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: m.context,
      output: m.maxOutput,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: m.releaseDate,
    variants: Object.fromEntries(
      // isCatalog only checks that reasoningOptions is an array; a hand-edited
      // or custom-URL catalog could carry non-strings, and garbage effort keys
      // would surface in the TUI picker and 400 upstream.
      m.reasoningOptions
        .filter((effort): effort is string => typeof effort === "string")
        .map((effort) => [effort, { reasoningEffort: effort }]),
    ),
  }
}

function toModels(catalog: Catalog, pricing: "off" | "reference"): Record<string, ModelV2> {
  // Entries were already validated by isCatalog in loadCatalog/readCache.
  const out: Record<string, ModelV2> = {}
  for (const m of catalog.models) out[m.id] = toModelV2(m, pricing)
  return out
}

const opencodeOllamaCloud: Plugin = async (_input, options) => {
  const pricing: "off" | "reference" = options?.pricing === "reference" ? "reference" : "off"
  const opts: PluginOpts = {
    catalogUrl:
      typeof options?.catalogUrl === "string" ? options.catalogUrl : undefined,
    timeoutMs: typeof options?.timeoutMs === "number" ? options.timeoutMs : undefined,
    pricing,
  }

  const { id: _id, ...providerConfig } = PROVIDER_CONFIG

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= { ...providerConfig }
    },
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => {
        try {
          const catalog = await loadCatalog(opts)
          if (catalog) {
            const models = toModels(catalog, pricing)
            if (Object.keys(models).length > 0) return models
          }
          console.warn("[opencode-ollama-cloud] no usable catalog, falling back to models.dev models")
        } catch (err) {
          console.warn(
            "[opencode-ollama-cloud] catalog load failed, falling back to models.dev models:",
            err,
          )
        }
        // Passthrough: models.dev's ollama-cloud entries carry no cost today,
        // but the reference contract holds regardless — a model without OUR
        // catalog's pricing never shows a cost, even if models.dev attaches
        // one later (cost here means the reference rate, not their number).
        const models: Record<string, ModelV2> = {}
        for (const [id, model] of Object.entries(provider.models))
          models[id] = { ...model, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
        return models
      },
    },
  }
}

export default opencodeOllamaCloud