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

function toModelV2(m: CatalogModel): ModelV2 {
  const vision = m.capabilities.vision || m.input.includes("image")
  const reasoning = m.capabilities.thinking
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
      interleaved: false,
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
      input: 0,
      output: 0,
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
  }
}

function toModels(catalog: Catalog): Record<string, ModelV2> {
  // Entries were already validated by isCatalog in loadCatalog/readCache.
  const out: Record<string, ModelV2> = {}
  for (const m of catalog.models) out[m.id] = toModelV2(m)
  return out
}

const opencodeOllamaCloud: Plugin = async (_input, options) => {
  const opts: PluginOpts = {
    catalogUrl:
      typeof options?.catalogUrl === "string" ? options.catalogUrl : undefined,
    timeoutMs: typeof options?.timeoutMs === "number" ? options.timeoutMs : undefined,
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
            const models = toModels(catalog)
            if (Object.keys(models).length > 0) return models
          }
          console.warn("[opencode-ollama-cloud] no usable catalog, falling back to models.dev models")
        } catch (err) {
          console.warn(
            "[opencode-ollama-cloud] catalog load failed, falling back to models.dev models:",
            err,
          )
        }
        return provider.models
      },
    },
  }
}

export default opencodeOllamaCloud