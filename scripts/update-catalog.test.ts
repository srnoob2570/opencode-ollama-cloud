import { describe, expect, test } from "bun:test"
import { isCatalog, type Catalog } from "../plugin/catalog.ts"
import { cardFor, parseLibraryPage, titleCase } from "./update-catalog.ts"

// Fixtures are representative excerpts of ollama.com/library/<model> markup as
// observed 2026-08 (see repo audit): capability chips use `rounded-md`, version
// chips use `rounded-full`, and link chips use `data-link=`.
const TEXT_MODEL_PAGE = `
<div class="my-3 flex flex-wrap space-x-2">
  <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
  <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">thinking</span>
</div>
<span class="inline-flex items-center rounded-full px-2 py-px text-xs font-medium border border-blue-500 text-blue-600">latest</span>
<a class="inline-flex items-center gap-1" data-link="python"></a>
<div class="text-lg">14GB · 128K context window · Text </div>
`

const VISION_MODEL_PAGE = `
<span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
<span class="inline-flex items-center rounded-md bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-600 sm:text-[13px]">vision</span>
<div>4.5GB · 256K context window · Text + Image </div>
`

// Markup drift: page loads fine (200) but neither the chips nor the info line
// match the selectors anymore. context must stay 0 so the update loop can
// detect the failure and keep previous values instead of regressing the catalog.
const DRIFTED_MARKUP = `
<html><body><main class="redesigned">
  <span class="chip v3">tools</span>
  <p>Context&nbsp;window:&nbsp;128K</p>
</main></body></html>
`

describe("parseLibraryPage", () => {
  test("parses current markup: capability chips, context window, text input", () => {
    const parsed = parseLibraryPage(TEXT_MODEL_PAGE)
    expect(parsed.capabilities).toEqual({ tools: true, thinking: true, vision: false })
    expect(parsed.context).toBe(128 * 1024)
    expect(parsed.input).toEqual(["text"])
  })

  test("parses vision capability and image input", () => {
    const parsed = parseLibraryPage(VISION_MODEL_PAGE)
    expect(parsed.capabilities.vision).toBe(true)
    expect(parsed.context).toBe(256 * 1024)
    expect(parsed.input).toEqual(["text", "image"])
  })

  test("version/link chips never set capabilities (rounded-full, data-link)", () => {
    const page = `
      <span class="inline-flex items-center rounded-full px-2 py-px text-xs border">tools</span>
      <a class="inline-flex items-center gap-1" data-link="tools"></a>
      <div>7GB · 128K context window · Text </div>
    `
    const parsed = parseLibraryPage(page)
    expect(parsed.capabilities.tools).toBe(false)
  })

  test("markup drift leaves context at 0 so the caller can detect failure", () => {
    const parsed = parseLibraryPage(DRIFTED_MARKUP)
    expect(parsed.context).toBe(0)
    expect(parsed.capabilities).toEqual({ tools: false, thinking: false, vision: false })
  })

  test("megabyte context windows convert to tokens", () => {
    const page = `<div>117GB · 1M context window · Text </div>`
    expect(parseLibraryPage(page).context).toBe(1024 * 1024)
  })
})

// /library/<family> lists every tag as a card: tag name in text-neutral-800,
// then the tag's own info line in text-neutral-500 (mobile form, extracted
// from /library/gemma4 2026-08). The page hero (first info line) describes the
// default tag only — gemma4:latest is 128K while the bigger tags are 256K,
// which is how gemma4:31b inherited a wrong context before per-tag cards.
const FAMILY_WITH_MIXED_TAGS = `
<div class="my-3 flex flex-wrap space-x-2">
  <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
  <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">thinking</span>
  <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">vision</span>
</div>
<div>6.0GB · 128K context window · Text, Image </div>
<a href="/library/gemma4:latest" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
  <span class="flex items-center">
    <p class="block group-hover:underline text-sm font-medium text-neutral-800">gemma4:latest</p>
  </span>
  <p class="flex text-neutral-500">6.0GB · 128K context window · Text, Image · 2 months ago</p>
</a>
<a href="/library/gemma4:31b" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
  <span class="flex items-center">
    <p class="block group-hover:underline text-sm font-medium text-neutral-800">gemma4:31b</p>
  </span>
  <p class="flex text-neutral-500">15GB · 256K context window · Text, Image · 2 months ago</p>
</a>
<a href="/library/gemma4:31b-cloud" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
  <span class="flex items-center">
    <p class="block group-hover:underline text-sm font-medium text-neutral-800">gemma4:31b-cloud</p>
  </span>
  <p class="flex text-neutral-500">High Usage · 256K context window · Text, Image · 2 months ago</p>
</a>
`

// Cloud-only families (glm-5.3, kimi-k3): /v1/models lists the bare id and the
// page's only card is "family:cloud" (colon form). Families served per-tag
// under a cloud deployment list "tag-cloud" cards (dash form, e.g.
// qwen3.5:397b) — the only card for that tag.
const CLOUD_FAMILY = `
<span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
<span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">thinking</span>
<div>High Usage · 1M context window · Text </div>
<a href="/library/glm-5.3:cloud" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
  <span class="flex items-center">
    <p class="block group-hover:underline text-sm font-medium text-neutral-800">glm-5.3:cloud</p>
  </span>
  <p class="flex text-neutral-500">High Usage · 1M context window · Text · 3 weeks ago</p>
</a>
<a href="/library/qwen3.5:397b-cloud" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
  <span class="flex items-center">
    <p class="block group-hover:underline text-sm font-medium text-neutral-800">qwen3.5:397b-cloud</p>
  </span>
  <p class="flex text-neutral-500">High Usage · 256K context window · Text, Image · 3 weeks ago</p>
</a>
`

describe("parseLibraryPage per-tag cards", () => {
  test("collects each tag's card specs alongside the family default", () => {
    const parsed = parseLibraryPage(FAMILY_WITH_MIXED_TAGS)
    expect(parsed.context).toBe(128 * 1024)
    expect(parsed.variants.get("gemma4:latest")).toEqual({
      context: 128 * 1024,
      input: ["text", "image"],
    })
    expect(parsed.variants.get("gemma4:31b")).toEqual({
      context: 256 * 1024,
      input: ["text", "image"],
    })
    expect(parsed.variants.get("gemma4:31b-cloud")).toEqual({
      context: 256 * 1024,
      input: ["text", "image"],
    })
  })

  test("a card whose info line drifted is skipped, not given the next card's specs", () => {
    const page = `
      <p class="text-neutral-800">gemma4:31b</p>
      <p class="text-neutral-500">15GB download · Text, Image</p>
      <p class="text-neutral-800">gemma4:12b</p>
      <p class="text-neutral-500">7.6GB · 256K context window · Text, Image</p>
    `
    const parsed = parseLibraryPage(page)
    expect(parsed.variants.has("gemma4:31b")).toBe(false)
    expect(parsed.variants.get("gemma4:12b")?.context).toBe(256 * 1024)
  })
})

describe("cardFor", () => {
  test("bare tags resolve to their own card", () => {
    const parsed = parseLibraryPage(FAMILY_WITH_MIXED_TAGS)
    expect(cardFor(parsed, "gemma4:31b")).toEqual({ context: 256 * 1024, input: ["text", "image"] })
  })

  test("tags without a card fall through to undefined (family default upstream)", () => {
    const parsed = parseLibraryPage(FAMILY_WITH_MIXED_TAGS)
    expect(cardFor(parsed, "gemma4:e2b")).toBeUndefined()
  })

  test("bare cloud ids resolve to their family:cloud card (glm-5.3)", () => {
    const parsed = parseLibraryPage(CLOUD_FAMILY)
    expect(cardFor(parsed, "glm-5.3")).toEqual({ context: 1024 * 1024, input: ["text"] })
  })

  test("tagged cloud-only ids resolve to their tag-cloud card (qwen3.5:397b)", () => {
    const parsed = parseLibraryPage(CLOUD_FAMILY)
    expect(cardFor(parsed, "qwen3.5:397b")).toEqual({ context: 256 * 1024, input: ["text", "image"] })
  })
})

describe("titleCase", () => {
  test("known acronyms are uppercased", () => {
    expect(titleCase("gpt-oss")).toBe("GPT OSS")
    expect(titleCase("glm-5.3-flash")).toBe("GLM 5.3 Flash")
  })

  test("ordinary short words are only capitalized (no PRO/MAX)", () => {
    expect(titleCase("deepseek-v4-pro")).toBe("Deepseek V4 Pro")
    expect(titleCase("some-max-model")).toBe("Some Max Model")
  })

  test("digit-leading and mixed names survive", () => {
    expect(titleCase("qwen3.5")).toBe("Qwen3.5")
    expect(titleCase("nemotron-3-nano")).toBe("Nemotron 3 Nano")
  })
})

describe("isCatalog", () => {
  const validModel = {
    id: "gpt-oss:120b",
    name: "GPT OSS (120b)",
    created: 1754402400,
    family: "gpt-oss",
    capabilities: { tools: true, thinking: true, vision: false },
    input: ["text"],
    context: 131072,
    maxOutput: 131072,
    reasoningOptions: [],
    releaseDate: "2026-08-05",
  }
  const validCatalog: Catalog = {
    provider: {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      api: "https://ollama.com/v1",
      npm: "@ai-sdk/openai-compatible",
      env: ["OLLAMA_API_KEY"],
    },
    generatedAt: "2026-08-27T00:00:00.000Z",
    modelsHash: "0".repeat(64),
    models: [validModel],
  }

  test("accepts a well-formed catalog", () => {
    expect(isCatalog(validCatalog)).toBe(true)
  })

  test("rejects context 0 (scrape-regression guard)", () => {
    const bad = { ...validCatalog, models: [{ ...validModel, context: 0 }] }
    expect(isCatalog(bad)).toBe(false)
  })

  test("rejects missing releaseDate (consumed as a required string downstream)", () => {
    const noDate: Record<string, unknown> = { ...validModel }
    delete noDate.releaseDate
    expect(isCatalog({ ...validCatalog, models: [noDate] })).toBe(false)
  })

  test("rejects missing family and non-array reasoningOptions", () => {
    const noFamily: Record<string, unknown> = { ...validModel }
    delete noFamily.family
    expect(isCatalog({ ...validCatalog, models: [noFamily] })).toBe(false)
    const badReasoning = { ...validModel, reasoningOptions: undefined }
    expect(isCatalog({ ...validCatalog, models: [badReasoning] })).toBe(false)
  })

  test("rejects non-objects and shapeless models", () => {
    expect(isCatalog(null)).toBe(false)
    expect(isCatalog("null")).toBe(false)
    expect(isCatalog({ ...validCatalog, models: [{ id: 42 }] })).toBe(false)
  })
})

// Optional pricing/provenance blocks: catalogs without them (old versions)
// stay valid; catalogs with them must carry the right shape so garbage
// prices never reach the plugin's cost mapping.
describe("isCatalog optional pricing blocks", () => {
  const validModel = {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    created: 1787929200,
    family: "glm",
    capabilities: { tools: true, thinking: true, vision: false },
    input: ["text"],
    context: 1024 * 1024,
    maxOutput: 131072,
    reasoningOptions: [],
    releaseDate: "2026-08-30",
  }
  const catalog = (model: Record<string, unknown>) => ({
    provider: { id: "ollama-cloud", name: "Ollama Cloud", api: "https://ollama.com/v1", npm: "@ai-sdk/openai-compatible", env: ["OLLAMA_API_KEY"] },
    generatedAt: "2026-08-30T00:00:00.000Z",
    modelsHash: "a".repeat(64),
    models: [model],
  })

  test("absent blocks pass (old catalogs load unchanged)", () => {
    expect(isCatalog(catalog(validModel) as unknown)).toBe(true)
  })

  test("well-shaped pricing passes", () => {
    const withPricing = {
      ...validModel,
      pricing: { input: 0.075, output: 0.25, unit: "per-1M", provider: "zai", source: "https://x", asOf: "2026-08-30" },
    }
    expect(isCatalog(catalog(withPricing) as unknown)).toBe(true)
  })

  test("garbage pricing is rejected (wrong unit, non-numeric costs)", () => {
    const badUnit = { ...validModel, pricing: { ...validModel, input: 1, output: 1, unit: "per-token" } }
    const badNumbers = { ...validModel, pricing: { input: "0.075", output: 0.25, unit: "per-1M", provider: "zai", source: "https://x", asOf: "2026-08-30" } }
    expect(isCatalog(catalog(badUnit) as unknown)).toBe(false)
    expect(isCatalog(catalog(badNumbers) as unknown)).toBe(false)
  })
})

describe("isCatalog pricing compat (code review fixes)", () => {
  const validModel = {
    id: "kimi-k3",
    name: "Kimi K3",
    created: 0,
    family: "kimi-k3",
    capabilities: { tools: true, thinking: true, vision: false },
    input: ["text"],
    context: 1024 * 1024,
    maxOutput: 131072,
    reasoningOptions: [],
    releaseDate: "2026-08-30",
  }
  const wrap = (model: Record<string, unknown>) => ({
    provider: { id: "ollama-cloud", name: "Ollama Cloud", api: "https://ollama.com/v1", npm: "@ai-sdk/openai-compatible", env: ["OLLAMA_API_KEY"] },
    generatedAt: "2026-08-30T00:00:00.000Z",
    modelsHash: "b".repeat(64),
    models: [model],
  })

  test("a foreign catalog with models.dev-shaped pricing ({input, output}) still loads", () => {
    expect(
      isCatalog(wrap({ ...validModel, pricing: { input: 0.2, output: 0.7 } }) as unknown),
    ).toBe(true)
  })

  test("negative, NaN and Infinity prices are rejected", () => {
    const bad = [{ input: -5, output: 2 }, { input: Number.NaN, output: 2 }, { input: 1e999, output: 2 }]
    for (const pricing of bad)
      expect(isCatalog(wrap({ ...validModel, pricing }) as unknown)).toBe(false)
  })
})
