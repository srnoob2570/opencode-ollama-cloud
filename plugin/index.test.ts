import { describe, expect, test } from "bun:test"
import type { CatalogModel } from "./catalog.ts"
import { toModelV2 } from "./index.ts"

// Fixtures mirror the live glm-5.3 / glm-5.1 catalog entries (2026-08): glm-5.3
// advertises thinking tiers, glm-5.1 thinking has no effort levels (toggle only).
const GLM53: CatalogModel = {
  id: "glm-5.3",
  name: "GLM 5.3",
  created: 1787929200,
  family: "glm-5.3",
  capabilities: { tools: true, thinking: true, vision: false },
  input: ["text"],
  context: 1048576,
  maxOutput: 131072,
  reasoningOptions: ["low", "high", "max"],
  releaseDate: "2026-08-14",
}

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