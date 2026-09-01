import type { Plugin } from "@opencode-ai/plugin"
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2"
import {
  PROVIDER_CONFIG,
  PROVIDER_ID,
  loadCatalog,
  type CatalogModel,
  type PluginOpts,
} from "./catalog.ts"
import { createStatsCapture, type FetchLike } from "./capture.ts"

// Catalog models without pricing data and the models.dev passthrough share the
// "zero reference cost" shape (opencode's CostV2, USD per 1M tokens). Factory,
// not constant: a shared mutable object would alias every model's cost.
const zeroCost = () => ({ input: 0, output: 0, cache: { read: 0, write: 0 } })

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
    cost: ref ? { ...zeroCost(), input: ref.input, output: ref.output } : zeroCost(),
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

const opencodeOllamaCloud: Plugin = async (_input, options) => {
  const pricing: "off" | "reference" = options?.pricing === "reference" ? "reference" : "off"
  // Stats knob (ticket 08): default ON — opt-out, the mirror of pricing. In
  // "off" the plugin behaves exactly as before the stats effort: no fetch
  // wrap, no event sink, no handoff, zero overhead.
  const stats: "on" | "off" = options?.stats === "off" ? "off" : "on"
  const opts: PluginOpts = {
    catalogUrl:
      typeof options?.catalogUrl === "string" ? options.catalogUrl : undefined,
    timeoutMs: typeof options?.timeoutMs === "number" ? options.timeoutMs : undefined,
  }

  const { id: _id, ...providerConfig } = PROVIDER_CONFIG
  // Stats capture (spec Pieza 1): wire wrapper for ollama-cloud + event sink.
  // All failure paths live inside the capture; nothing here may throw.
  // In "off" mode the capture is never created and the hooks below simply
  // leave the plugin as it was before the stats effort.
  const capture = stats === "on" ? createStatsCapture() : null

  return {
    ...(capture
      ? { event: ({ event }: { event: unknown }) => capture.handleEvent(event) }
      : {}),
    config: async (cfg) => {
      cfg.provider ??= {}
      const provider = (cfg.provider[PROVIDER_ID] ??= { ...providerConfig })
      if (!capture) return
      // opencode honors a provider `options.fetch` (its seam wraps it with
      // timeouts and passes the signal through). We wrap AROUND any existing
      // custom fetch (proxy/CA/agent) instead of clobbering it — only SSE
      // chat calls get measured, everything else flows through untouched.
      const providerWithOptions = provider as { options?: Record<string, unknown> }
      const userFetch = (providerWithOptions.options?.fetch ?? null) as FetchLike | null
      providerWithOptions.options = {
        ...providerWithOptions.options,
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          capture.wireFetch(input, init, userFetch ?? undefined),
      }
    },
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => {
        try {
          const catalog = await loadCatalog(opts)
          if (catalog) {
            // Entries were already validated by isCatalog in loadCatalog/readCache.
            const models: Record<string, ModelV2> = {}
            for (const m of catalog.models) models[m.id] = toModelV2(m, pricing)
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
          models[id] = { ...model, cost: zeroCost() }
        return models
      },
    },
  }
}

export default opencodeOllamaCloud