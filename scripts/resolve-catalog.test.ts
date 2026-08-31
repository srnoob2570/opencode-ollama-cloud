import { describe, expect, test } from "bun:test"
import type { CatalogModel } from "../plugin/catalog.ts"
import { MODELS_DEV_URL, resolveCatalog, type PricingOverrides } from "./resolve-catalog.ts"

// Seed excerpt mirrors models.dev 2026-08-30 for the mapped families
// (wayfinder ticket "tabla de precio de referencia por modelo"). Costs are
// USD per 1M tokens, models.dev's own unit.
const SEED = {
  zai: { models: { "glm-5.3-flash": { cost: { input: 0.075, output: 0.25 } } } },
  moonshotai: { models: { "kimi-k3": { cost: { input: 3, output: 15 } } } },
  deepseek: { models: { "deepseek-v4-pro": { cost: { input: 0.435, output: 0.87 } } } },
  alibaba: { models: { "qwen3.5-397b-a17b": { cost: { input: 0.6, output: 3.6 } } } },
  nvidia: {
    models: {
      // nvidia lists the nano free (0/0): not a real price, never seed-picked
      "nemotron-3-nano-30b": { cost: { input: 0, output: 0 } },
    },
  },
  provider_unrelated: { models: { "glm-5.3-flash": { cost: { input: 9, output: 9 } } } },
}

const model = (id: string): CatalogModel => ({
  id,
  name: id,
  created: 0,
  family: id.split(":")[0],
  capabilities: { tools: true, thinking: false, vision: false },
  input: ["text"],
  context: 128 * 1024,
  maxOutput: 32768,
  reasoningOptions: [],
  releaseDate: "2026-08-30",
})

const resolve = (models: CatalogModel[], overrides: PricingOverrides = {}, today = "2026-08-30") =>
  resolveCatalog(models, { seed: SEED, overrides, today })

describe("resolveCatalog first-party rule", () => {
  test("seed-picks the first-party provider price", () => {
    const [m] = resolve([model("glm-5.3-flash")]).models
    expect(m.pricing).toEqual({
      input: 0.075,
      output: 0.25,
      unit: "per-1M",
      provider: "zai",
      source: MODELS_DEV_URL,
      asOf: "2026-08-30",
    })
    expect(m.sources?.pricing).toBe("models.dev")
  })

  test("ignores higher-priced non-first-party hosts of the same model", () => {
    const [m] = resolve([model("glm-5.3-flash")]).models
    expect(m.pricing?.input).toBe(0.075)
  })

  test("tagged ids resolve via documented upstream aliases", () => {
    const [m] = resolve([model("qwen3.5:397b")]).models
    expect(m.pricing).toMatchObject({ input: 0.6, output: 3.6, provider: "alibaba" })
  })

  test("0/0 first-party entries are not prices (no first-party pick)", () => {
    const [m] = resolve([model("nemotron-3-nano:30b")]).models
    // no marketplace candidates in SEED either → no pricing, but a warning
    expect(m.pricing).toBeUndefined()
  })
})

describe("resolveCatalog overrides", () => {
  test("override wins and is marked as such", () => {
    const overrides: PricingOverrides = {
      "kimi-k3": { input: 3, output: 15, provider: "moonshotai", source: "https://example.com" },
    }
    const [m] = resolve([model("kimi-k3")], overrides).models
    expect(m.pricing).toEqual({
      input: 3,
      output: 15,
      unit: "per-1M",
      provider: "moonshotai",
      source: "https://example.com",
      asOf: "2026-08-30",
    })
    expect(m.sources?.pricing).toBe("override")
    expect(m.conflicts?.pricing).toBeUndefined() // same value as seed: no disagreement
  })

  test("override that differs from the seed records the conflict (override wins)", () => {
    const overrides: PricingOverrides = {
      "deepseek-v4-pro:0813": {
        input: 1.32,
        output: 3.96,
        provider: "deepseek",
        source: "https://example.com/docs",
        note: "tarifa oficial peak vigente",
      },
    }
    const [m] = resolve([model("deepseek-v4-pro:0813")], overrides).models
    expect(m.pricing).toMatchObject({ input: 1.32, output: 3.96, note: "tarifa oficial peak vigente" })
    expect(m.conflicts?.pricing).toEqual({
      "models.dev": { input: 0.435, output: 0.87 },
      resolver: "override-wins",
    })
  })

  test("invalid overrides (zero/negative or absent numbers) are ignored, not trusted", () => {
    const overrides: PricingOverrides = {
      "kimi-k3": { input: 0, output: 15 },
      "glm-5.3-flash": { input: -1, output: 1 },
    }
    const models = resolve([model("kimi-k3"), model("glm-5.3-flash")], overrides).models
    expect(models[0].sources?.pricing).toBe("models.dev")
    expect(models[1].sources?.pricing).toBe("models.dev")
  })
})

describe("resolveCatalog marketplace mode", () => {
  test("no first-party entry falls back to the most common real price, marked derived", () => {
    const seed = {
      ...SEED,
      host_a: { models: { "gpt-oss:120b": { cost: { input: 0.3, output: 1.2 } } } },
      host_b: { models: { "gpt-oss:120b": { cost: { input: 0.15, output: 0.6 } } } },
      host_c: { models: { "gpt-oss:120b": { cost: { input: 0.15, output: 0.6 } } } },
    }
    const { models, warnings } = resolveCatalog([model("gpt-oss:120b")], { seed, overrides: {}, today: "2026-08-30" })
    expect(models[0].pricing).toMatchObject({ input: 0.15, output: 0.6, provider: "derived" })
    expect(models[0].sources?.pricing).toBe("models.dev")
    expect(warnings.some((w) => w.includes("gpt-oss:120b"))).toBe(true)
  })

  test("no data at all yields no pricing and a warning (plugin maps it to $0)", () => {
    const { models, warnings } = resolveCatalog([model("totally-unknown")], { seed: {}, overrides: {}, today: "2026-08-30" })
    expect(models[0].pricing).toBeUndefined()
    expect(warnings.some((w) => w.includes("totally-unknown"))).toBe(true)
  })
})
describe("resolveCatalog hardening (code review fixes)", () => {
  test("a malformed override is ignored with a warning and never poisons the catalog", () => {
    // a hand-edited override with a non-string provider would flow into the
    // catalog and make isCatalog reject EVERYTHING (all models vanish)
    const overrides: any = {
      "kimi-k3": { input: 3, output: 15, provider: ["not", "a", "string"] },
    }
    const { models, warnings } = resolve([model("kimi-k3")], overrides)
    expect(models[0].pricing?.provider).toBe("moonshotai") // seed picked, nothing poisoned
    expect(models[0].sources?.pricing).toBe("models.dev")
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true)
  })

  test("an override key that matches no model warns instead of applying silently", () => {
    const overrides: PricingOverrides = {
      "deepseek-v4-pro:813": { input: 1.32, output: 3.96 }, // typo: missing a 0
    }
    const { warnings } = resolve([model("kimi-k3")], overrides)
    expect(warnings.some((w) => w.includes("matched no model in the live list"))).toBe(true)
  })

  test("override asOf is the date the value was taken, not run date", () => {
    const overrides: PricingOverrides = {
      "kimi-k3": { input: 3, output: 15, asOf: "2026-08-30" },
    }
    const [m] = resolve([model("kimi-k3")], overrides, "2026-09-15").models
    expect(m.pricing?.asOf).toBe("2026-08-30")
  })

  test("marketplace tiebreak is deterministic regardless of seed key order", () => {
    const host = (name: string, output: number, input = 0.12) => ({
      [name]: { models: { "gpt-oss:120b": { cost: { input, output } } } },
    })
    const seedA = { ...host("a", 0.6), ...host("b", 0.4) }
    const seedB = { ...host("a", 0.4), ...host("b", 0.6) } // same content, different order
    const run = (seed: any) =>
      resolveCatalog([model("gpt-oss:120b")], { seed, overrides: {}, today: "2026-08-30" }).models[0]
        .pricing?.output
    expect(run(seedA)).toBe(0.4)
    expect(run(seedB)).toBe(0.4)
  })

  test("the real overrides file is well-formed (every entry consumable)", async () => {
    const file = Bun.file(new URL("../catalog/pricing-overrides.json", import.meta.url))
    const overrides = await file.json()
    for (const [id, entry] of Object.entries<any>(overrides)) {
      expect(typeof entry.input).toBe("number")
      expect(Number.isFinite(entry.input) && entry.input > 0).toBe(true)
      expect(Number.isFinite(entry.output) && entry.output > 0).toBe(true)
      expect(typeof entry.provider).toBe("string")
      expect(typeof entry.source).toBe("string")
      expect(typeof entry.asOf).toBe("string")
    }
  })
})
