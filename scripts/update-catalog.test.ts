import { describe, expect, test } from "bun:test"
import { isCatalog, type Catalog } from "../plugin/catalog.ts"
import { parseLibraryPage, titleCase } from "./update-catalog.ts"

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
