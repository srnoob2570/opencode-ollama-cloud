import { describe, expect, test } from "bun:test"
import { catalogModel } from "../scripts/test-fixtures.ts"
import type { CatalogModel } from "./catalog.ts"
import { toModelV2 } from "./index.ts"
import opencodeOllamaCloud from "./index.ts"

// Fixture mirrors the live glm-5.3 catalog entry (2026-08): glm-5.3 advertises
// thinking tiers, glm-5.1 thinking has no effort levels (toggle only).
const GLM53: CatalogModel = catalogModel("glm-5.3", {
  name: "GLM 5.3",
  created: 1787929200,
  capabilities: { tools: true, thinking: true, vision: false },
  context: 1048576,
  maxOutput: 131072,
  reasoningOptions: ["low", "high", "max"],
  releaseDate: "2026-08-14",
})

const GLM51: CatalogModel = { ...GLM53, id: "glm-5.1", reasoningOptions: [] }

describe("toModelV2 variants", () => {
  test("effort tiers become rotatable variants with openai-compatible payloads", () => {
    const model = toModelV2(GLM53)
    expect(Object.keys(model.variants ?? {})).toEqual(["low", "high", "max"])
    expect(model.variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("thinking without effort levels yields no variants (nothing to rotate)", () => {
    expect(Object.keys(toModelV2(GLM51).variants ?? {})).toEqual([])
  })

  test("non-string entries are dropped (isCatalog only checks the array shape)", () => {
    const dirty = { ...GLM53, reasoningOptions: ["low", 42, null, "high"] } as unknown as CatalogModel
    expect(Object.keys(toModelV2(dirty).variants ?? {})).toEqual(["low", "high"])
  })

  test("thinking capability is still exposed as capabilities.reasoning", () => {
    expect(toModelV2(GLM53).capabilities.reasoning).toBe(true)
  })
})

describe("toModelV2 interleaved", () => {
  test("thinking models replay reasoning via ollama's `reasoning` wire field", () => {
    expect(toModelV2(GLM53).capabilities.interleaved).toEqual({ field: "reasoning" })
  })

  test("non-thinking models keep interleaved off (no reasoning parts to replay)", () => {
    const noThink = { ...GLM53, capabilities: { tools: true, thinking: false, vision: false } }
    expect(toModelV2(noThink).capabilities.interleaved).toBe(false)
  })
})
// Reference pricing: opt-in via the plugin knob (`pricing: "reference"`).
// Prices live in the catalog as USD per 1M tokens — opencode's CostV2 unit.
const PRICED: CatalogModel = {
  ...GLM53,
  pricing: {
    input: 0.075,
    output: 0.25,
    unit: "per-1M",
    provider: "zai",
    source: "https://models.dev/api.json",
    asOf: "2026-08-30",
  },
}

describe("toModelV2 pricing", () => {
  test("default (off) keeps the cost counter at zero even when pricing exists", () => {
    const model = toModelV2(PRICED)
    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })

  test("reference mode maps the catalog pricing into the cost counter", () => {
    const model = toModelV2(PRICED, "reference")
    expect(model.cost).toEqual({ input: 0.075, output: 0.25, cache: { read: 0, write: 0 } })
  })

  test("models without pricing data stay at $0 in both modes (no partial estimates)", () => {
    expect(toModelV2(PRICED, "reference").cost.input).toBe(0.075)
    expect(toModelV2(GLM53, "reference").cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })
})

// Stats knob (ticket 08): default ON, opt-out. In "off" the plugin must be
// behavior-identical to pre-stats: no provider options.fetch, no event hook.
describe("stats knob", () => {
  const make = async (opts: Record<string, unknown>) => {
    const plugin = await opencodeOllamaCloud({} as never, opts as never)
    const cfg = { provider: {} as Record<string, Record<string, unknown>> }
    await (plugin as any).config(cfg)
    return { plugin, cfg }
  }

  test("default (on): inyecta fetch en el provider y registra el event sink", async () => {
    const { plugin, cfg } = await make({})
    expect((cfg.provider["ollama-cloud"].options as Record<string, unknown>).fetch).toBeTypeOf("function")
    expect((plugin as any).event).toBeTypeOf("function")
  })

  test("stats: off — plugin reducido a provider/catálogo (cero overhead)", async () => {
    const { plugin, cfg } = await make({ stats: "off" })
    expect((cfg.provider["ollama-cloud"]).options).toBeUndefined()
    expect((plugin as any).event).toBeUndefined()
  })
})
