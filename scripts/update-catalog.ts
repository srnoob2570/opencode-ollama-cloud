import { createHash } from "node:crypto"
import {
  PROVIDER_CONFIG,
  type Catalog as BaseCatalog,
  type CatalogModel,
} from "../plugin/catalog.ts"

const MODELS_API = "https://ollama.com/v1/models"
const LIBRARY_URL = (base: string) => `https://ollama.com/library/${base}`
const MODEL_SEED_URL = "https://models.dev/api.json"

const CATALOG_PATH = new URL("../catalog/catalog.json", import.meta.url).pathname

type OllamaModel = { id: string; created: number }

type Catalog = BaseCatalog & { $schema: string }

const DEFAULT_MAX_OUTPUT = 32768

const titleCase = (base: string) =>
  base
    .split(/[-_:]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 && !/^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")

const baseOf = (id: string) => (id.includes(":") ? id.slice(0, id.indexOf(":")) : id)

const hashOf = (models: OllamaModel[]) =>
  createHash("sha256")
    .update(models.map((m) => `${m.id}:${m.created}`).sort().join("|"))
    .digest("hex")

function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": "opencode-ollama-cloud-updater" },
    signal: AbortSignal.timeout(20_000),
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

function parseLibraryPage(html: string) {
  const result = {
    capabilities: { tools: false, thinking: false, vision: false },
    context: 0,
    input: ["text"] as string[],
  }

  const chipRe = /inline-flex[^>]*>([a-z]+)</g
  for (const chip of html.matchAll(chipRe)) {
    const value = chip[1]
    if (value === "tools") result.capabilities.tools = true
    if (value === "thinking") result.capabilities.thinking = true
    if (value === "vision") result.capabilities.vision = true
  }

  const infoLine = html.match(
    /([A-Za-z]+ Usage|[0-9.]+[GM]B)\s*·\s*(\d+(?:\.\d+)?)\s*([KM])\s*context window\s*·\s*([^·<]+)/,
  )
  if (infoLine) {
    const n = Number(infoLine[2])
    result.context = Math.round(infoLine[3] === "K" ? n * 1024 : n * 1024 * 1024)
    result.input = parseInputTypes(infoLine[4])
  }

  return result
}

function parseInputTypes(text: string): string[] {
  const input: string[] = []
  if (/\bText\b/i.test(text)) input.push("text")
  if (/\bImage\b/i.test(text)) input.push("image")
  return input.length ? input : ["text"]
}

function buildSeedIndex(seed: Record<string, any>, providerIds?: string[]) {
  const byId: Record<string, any> = {}
  const byFamily: Record<string, any> = {}
  for (const [provId, provider] of Object.entries<any>(seed)) {
    if (providerIds && !providerIds.includes(provId)) continue
    for (const [modelId, model] of Object.entries<any>(provider?.models ?? {})) {
      byId[modelId] ??= model
      const base = modelId.split(":")[0]
      byFamily[base] ??= model
    }
  }
  return { byId, byFamily }
}

function seedPick(
  { byId, byFamily }: ReturnType<typeof buildSeedIndex>,
  id: string,
  family: string,
) {
  return byId[id] ?? byId[family] ?? byFamily[family] ?? byFamily[id]
}

function mergeSeed(catalogModels: CatalogModel[], seed: Record<string, any>): CatalogModel[] {
  const prioritized = buildSeedIndex(seed, ["ollama-cloud"])
  const all = buildSeedIndex(seed)
  return catalogModels.map((m) => {
    const s = seedPick(prioritized, m.id, m.family) ?? seedPick(all, m.id, m.family)
    return {
      ...m,
      maxOutput: s?.limit?.output ?? m.maxOutput,
      reasoningOptions: s?.reasoning_options?.map((r: any) => r?.values).flat().filter(Boolean) ?? m.reasoningOptions,
      releaseDate: s?.release_date ?? m.releaseDate,
    }
  })
}

function buildEmptyCatalog(): Catalog {
  return {
    $schema: "./catalog.schema.json",
    provider: { ...PROVIDER_CONFIG, env: [...PROVIDER_CONFIG.env] },
    generatedAt: "",
    modelsHash: "",
    models: [],
  }
}

async function loadCatalog(): Promise<Catalog> {
  const file = Bun.file(CATALOG_PATH)
  if (await file.exists()) return (await file.json()) as Catalog
  return buildEmptyCatalog()
}

async function main() {
  const mode = process.argv[2] === "check" ? "check" : "update"

  const api = await fetchJson<{ data: OllamaModel[] }>(MODELS_API)
  const live = api.data
  if (!live?.length) throw new Error("ollama.com/v1/models returned no models")

  const liveHash = hashOf(live)
  const catalog = await loadCatalog()

  if (mode === "check") {
    if (catalog.modelsHash === liveHash) {
      console.log("unchanged")
      process.exit(0)
    }
    console.log("changed")
    process.exit(1)
  }

  // Re-scrape weekly even when the /v1/models hash is unchanged, so enrichment
  // data (context windows, capabilities, seed info) for existing models gets refreshed.
  const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
  const stale =
    !catalog.generatedAt || Date.now() - Date.parse(catalog.generatedAt) > STALE_AFTER_MS

  if (catalog.modelsHash === liveHash && !stale) {
    console.log("catalog already up to date")
    process.exit(0)
  }
  if (stale) console.log("catalog stale; forcing refresh")

  const seed = await fetchJson<Record<string, any>>(MODEL_SEED_URL).catch(() => ({}))

  const byBase = new Map<string, OllamaModel[]>()
  for (const m of live) {
    const base = baseOf(m.id)
    byBase.set(base, [...(byBase.get(base) ?? []), m])
  }

  const cache = new Map<string, Awaited<ReturnType<typeof parseLibraryPage>>>()
  const prevByBase = new Map<string, CatalogModel>()
  for (const m of catalog.models) if (!prevByBase.has(m.family)) prevByBase.set(m.family, m)
  const models: CatalogModel[] = []

  // Scrape library pages with bounded concurrency instead of strictly sequentially.
  const bases = [...byBase.keys()]
  const SCRAPE_CONCURRENCY = 5
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(SCRAPE_CONCURRENCY, bases.length) }, async () => {
      while (cursor < bases.length) {
        const base = bases[cursor++]
        const html = await fetchWithTimeout(LIBRARY_URL(base))
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
        const parsed = parseLibraryPage(html)
        if (html === "" && prevByBase.has(base)) {
          // scrape failed; keep previous values so a refresh can't regress the catalog
          const prev = prevByBase.get(base)!
          parsed.capabilities = prev.capabilities
          parsed.context = prev.context
          parsed.input = prev.input
        }
        cache.set(base, parsed)
      }
    }),
  )

  for (const [base, variants] of byBase) {
    const parsed = cache.get(base)!

    for (const variant of variants) {
      const tag = variant.id.includes(":") ? variant.id.split(":")[1] : ""
      models.push({
        id: variant.id,
        name: titleCase(base) + (tag ? ` (${tag})` : ""),
        created: variant.created,
        family: base,
        capabilities: parsed.capabilities,
        input: parsed.input,
        context: parsed.context,
        maxOutput: DEFAULT_MAX_OUTPUT,
        reasoningOptions: [],
        releaseDate: new Date(variant.created * 1000).toISOString().slice(0, 10),
      })
    }
  }

  const merged = mergeSeed(models, seed)

  const next: Catalog = {
    ...catalog,
    generatedAt: new Date().toISOString(),
    modelsHash: liveHash,
    models: merged.sort((a, b) => b.created - a.created),
  }

  await Bun.write(CATALOG_PATH, JSON.stringify(next, null, 2) + "\n")
  console.log(`catalog updated: ${merged.length} models, ${byBase.size} bases scraped`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})