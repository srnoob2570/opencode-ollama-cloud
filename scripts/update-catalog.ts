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

// Uppercase only known acronyms. The old rule (length <= 3) also uppercased
// ordinary short words, producing names like "Deepseek V4 PRO".
const KNOWN_ACRONYMS = new Set(["gpt", "oss", "glm", "llm"])

export const titleCase = (base: string) =>
  base
    .split(/[-_:]/)
    .filter(Boolean)
    .map((part) =>
      KNOWN_ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
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

const INFO_LINE_RE =
  /([A-Za-z]+ Usage|[0-9.]+[GM]B)\s*·\s*(\d+(?:\.\d+)?)\s*([KM])\s*context window\s*·\s*([^·<]+)/

export function parseLibraryPage(html: string) {
  const result = {
    capabilities: { tools: false, thinking: false, vision: false },
    context: 0,
    input: ["text"] as string[],
    // Per-tag specs from the variant cards on the same page, keyed by the full
    // tag id as it appears there ("gemma4:31b", "gemma4:31b-cloud"). Tags can
    // differ from the default the first info line describes — gemma4:latest is
    // 128K while gemma4:31b is 256K — so tagged models must not inherit the
    // family default blindly.
    variants: new Map<string, { context: number; input: string[] }>(),
  }

  // Capability chips use rounded-md styling (verified against ollama.com/library
  // markup, 2026-08). A looser inline-flex match would also catch version chips
  // (rounded-full, e.g. "latest") and data-link chips — a version tag literally
  // named "tools" would then falsely set capabilities.
  const chipRe = /inline-flex items-center rounded-md[^>]*>([a-z]+)</g
  for (const chip of html.matchAll(chipRe)) {
    const value = chip[1]
    if (value === "tools") result.capabilities.tools = true
    if (value === "thinking") result.capabilities.thinking = true
    if (value === "vision") result.capabilities.vision = true
  }

  const infoLine = html.match(INFO_LINE_RE)
  if (infoLine) {
    const n = Number(infoLine[2])
    result.context = Math.round(infoLine[3] === "K" ? n * 1024 : n * 1024 * 1024)
    result.input = parseInputTypes(infoLine[4])
  }

  // Variant cards (mobile form — the desktop grid repeats the tag inside an
  // <a>, which doesn't match): tag name, then its own info line. The gap is
  // bounded so a card without a parseable info line is skipped instead of
  // matching the next card's; a repeated tag keeps its first entry.
  const cardRe = /text-neutral-800">([\w.\-]+:[\w.\-]+)<\/p>[\s\S]{0,600}?text-neutral-500">([^<]+)<\/p>/g
  for (const card of html.matchAll(cardRe)) {
    if (result.variants.has(card[1])) continue
    const m = card[2].match(INFO_LINE_RE)
    if (!m) continue
    const n = Number(m[2])
    result.variants.set(card[1], {
      context: Math.round(m[3] === "K" ? n * 1024 : n * 1024 * 1024),
      input: parseInputTypes(m[4]),
    })
  }

  return result
}

// Per-tag card for a /v1/models id. Pages key their cards three ways (verified
// 2026-08): the bare tag ("gemma4:31b"), its cloud deployment
// ("gemma4:31b-cloud", "qwen3.5:397b-cloud"), or, for cloud-only families,
// "family:cloud" while /v1/models lists the bare id ("glm-5.3").
export function cardFor(
  parsed: ReturnType<typeof parseLibraryPage>,
  id: string,
): { context: number; input: string[] } | undefined {
  return (
    parsed.variants.get(id) ??
    parsed.variants.get(`${id}-cloud`) ??
    parsed.variants.get(`${id}:cloud`)
  )
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
  // Previous rows per family, keyed per id: on scrape failure each tag restores
  // its own specs instead of one family-wide value.
  const prevByBase = new Map<string, CatalogModel[]>()
  for (const m of catalog.models)
    prevByBase.set(m.family, [...(prevByBase.get(m.family) ?? []), m])
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
        // A fetch failure (html === "") and a markup change (page loads but no
        // context line matches, so context stays 0) are the same failure mode:
        // never let either regress the catalog to context: 0 + no capabilities.
        const scrapeFailed = html === "" || parsed.context === 0
        if (scrapeFailed && prevByBase.has(base)) {
          // Keep previous values so a refresh can't regress the catalog. Restored
          // under the exact row id, which is the first key cardFor() tries.
          const prev = prevByBase.get(base)!
          for (const row of prev)
            parsed.variants.set(row.id, { context: row.context, input: [...row.input] })
          parsed.capabilities = prev[0].capabilities
          parsed.context = prev[0].context
          parsed.input = [...prev[0].input]
        } else if (scrapeFailed) {
          // No previous data to fall back on: abort the whole update rather
          // than write a catalog that violates the schema (context minimum 1).
          // CI fails loudly and the next scheduled run retries.
          throw new Error(
            `failed to scrape "ollama.com/library/${base}" (no context window found, no previous data to keep)`,
          )
        }
        cache.set(base, parsed)
      }
    }),
  )

  for (const [base, variants] of byBase) {
    const parsed = cache.get(base)!

    for (const variant of variants) {
      const tag = variant.id.includes(":") ? variant.id.split(":")[1] : ""
      // Prefer the tag's own card over the family default — the first info
      // line on the page describes the default tag only, and other tags can
      // differ (gemma4:latest is 128K while gemma4:12b..:31b are 256K).
      const card = cardFor(parsed, variant.id)
      models.push({
        id: variant.id,
        name: titleCase(base) + (tag ? ` (${tag})` : ""),
        created: variant.created,
        family: base,
        capabilities: parsed.capabilities,
        input: card?.input ?? parsed.input,
        context: card?.context ?? parsed.context,
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
    // /v1/models returns tags in no stable order and some share a created
    // timestamp (gpt-oss:120b/:20b); the id tiebreak keeps regenerations of an
    // unchanged model list from producing a reordered — and thus "changed" —
    // catalog.
    models: merged.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)),
  }

  await Bun.write(CATALOG_PATH, JSON.stringify(next, null, 2) + "\n")
  console.log(`catalog updated: ${merged.length} models, ${byBase.size} bases scraped`)
}

// Guarded so tests and the validator can import pure functions (parseLibraryPage,
// titleCase) without triggering an update run.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}