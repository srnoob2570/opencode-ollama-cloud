import { createHash } from "node:crypto"
import { rename } from "node:fs/promises"
import {
  PROVIDER_CONFIG,
  type Catalog as BaseCatalog,
  type CatalogModel,
} from "../plugin/catalog.ts"
import {
  MODELS_DEV_URL,
  familyOf,
  resolveCatalog,
  tagOf,
  type PricingOverrides,
} from "./resolve-catalog.ts"
import {
  QUANT_UNKNOWN,
  REGISTRY_BLOB_URL,
  REGISTRY_MANIFEST_URL,
  SHOW_URL,
  cloudRefFor,
  fileTypeFromBlob,
  quantizationFromShow,
  resolveQuantization,
  type QuantizationResult,
} from "./quantization.ts"

const MODELS_API = "https://ollama.com/v1/models"
const LIBRARY_URL = (family: string) => `https://ollama.com/library/${family}`

const CATALOG_PATH = new URL("../catalog/catalog.json", import.meta.url).pathname
const OVERRIDES_PATH = new URL("../catalog/pricing-overrides.json", import.meta.url).pathname

// Reference-price overrides (catalog/pricing-overrides.json) are manual
// corrections. Absent file = trust the seed entirely; a PRESENT file that
// fails to parse aborts loudly — silently dropping manual corrections would
// publish stale prices as if they were fresh.
async function loadOverrides(): Promise<PricingOverrides> {
  const file = Bun.file(OVERRIDES_PATH)
  if (!(await file.exists())) return {}
  const raw = await file.json()
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("pricing-overrides.json must be an object keyed by model id")
  return raw as PricingOverrides
}

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

function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": "opencode-ollama-cloud-updater" },
    signal: AbortSignal.timeout(20_000),
  })
}

// CI-side fetch: fail loud (throw) so a broken endpoint blocks the update.
// The plugin's fetchCatalogJson (plugin/catalog.ts) is intentionally the
// opposite — best-effort, returns null — because the runtime must never throw.
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
      byFamily[familyOf(modelId)] ??= model
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
  // A torn write must not wedge the updater — the crash would destroy its own
  // repair path on every subsequent run. Treat an unparsable catalog like a
  // missing one and rebuild.
  try {
    if (await file.exists()) return (await file.json()) as Catalog
  } catch {
    console.warn("warning: catalog/catalog.json is unparsable; regenerating from scratch")
  }
  return buildEmptyCatalog()
}

const MODES = ["check", "update"] as const
type Mode = (typeof MODES)[number]

async function main() {
  // Strict CLI: previously any unknown argument silently ran a full "update"
  // (scrape + atomic write). A typo like `chek` must fail, not publish.
  const args = process.argv.slice(2)
  const knownArgs = new Set<string>([...MODES, "--force"])
  const unknown = args.filter((a) => !knownArgs.has(a))
  // Deduped: a repeated identical mode (check check) is accepted, as the old
  // lax parser did; only genuinely conflicting modes are an error.
  const modes = [...new Set(args.filter((a): a is Mode => (MODES as readonly string[]).includes(a)))]
  if (unknown.length > 0 || modes.length > 1) {
    if (unknown.length > 0) console.error(`unknown argument(s): ${unknown.join(", ")}`)
    if (modes.length > 1) console.error(`conflicting modes: ${modes.join(", ")}`)
    console.error("usage: bun scripts/update-catalog.ts [check|update] [--force]")
    process.exit(1)
  }
  const mode = modes[0] ?? "update"
  // --force regenerates even when /v1/models is unchanged: used after changing
  // enrichment (e.g. adding pricing) so the hash gate doesn't hide the new data.
  const force = args.includes("--force")
  if (mode === "check" && force) console.warn("warning: --force has no effect in check mode")

  const api = await fetchJson<{ data: OllamaModel[] }>(MODELS_API)
  const live = api.data
  if (!live?.length) throw new Error("ollama.com/v1/models returned no models")

  const liveHash = createHash("sha256")
    .update(live.map((m) => `${m.id}:${m.created}`).sort().join("|"))
    .digest("hex")
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
  // data (context windows, capabilities, seed info, pricing) for existing
  // models gets refreshed. --force does the same on demand.
  const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
  const stale =
    force ||
    !catalog.generatedAt ||
    Date.now() - Date.parse(catalog.generatedAt) > STALE_AFTER_MS

  if (catalog.modelsHash === liveHash && !stale) {
    console.log("catalog already up to date")
    process.exit(0)
  }
  if (stale) console.log("catalog stale; forcing refresh")

  const seed = await fetchJson<Record<string, any>>(MODELS_DEV_URL).catch(() => ({}))
  // The seed carries maxOutput, reasoningOptions, releaseDate and the
  // first-party pricing rule. An empty seed (transient models.dev outage)
  // would publish a silently regressed catalog — context windows stay but
  // maxOutput falls back to 32768 and prices evaporate. Same policy as a
  // failed library scrape: abort loudly and let the next scheduled run retry.
  if (!Object.keys(seed).length)
    throw new Error("models.dev seed is empty — aborting instead of publishing a regressed catalog")

  const byFamily = new Map<string, OllamaModel[]>()
  for (const m of live) {
    const family = familyOf(m.id)
    byFamily.set(family, [...(byFamily.get(family) ?? []), m])
  }

  const cache = new Map<string, Awaited<ReturnType<typeof parseLibraryPage>>>()
  // Previous rows per family, keyed per id: on scrape failure each tag restores
  // its own specs instead of one family-wide value.
  const prevByFamily = new Map<string, CatalogModel[]>()
  for (const m of catalog.models)
    prevByFamily.set(m.family, [...(prevByFamily.get(m.family) ?? []), m])
  const models: CatalogModel[] = []

  // Scrape library pages with bounded concurrency instead of strictly sequentially.
  const families = [...byFamily.keys()]
  const SCRAPE_CONCURRENCY = 5
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(SCRAPE_CONCURRENCY, families.length) }, async () => {
      while (cursor < families.length) {
        const family = families[cursor++]
        const html = await fetchWithTimeout(LIBRARY_URL(family))
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
        const parsed = parseLibraryPage(html)
        // A fetch failure (html === "") and a markup change (page loads but no
        // context line matches, so context stays 0) are the same failure mode:
        // never let either regress the catalog to context: 0 + no capabilities.
        const scrapeFailed = html === "" || parsed.context === 0
        if (scrapeFailed && prevByFamily.has(family)) {
          // Keep previous values so a refresh can't regress the catalog. Restored
          // under the exact row id, which is the first key cardFor() tries.
          const prev = prevByFamily.get(family)!
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
            `failed to scrape "ollama.com/library/${family}" (no context window found, no previous data to keep)`,
          )
        }
        cache.set(family, parsed)
      }
    }),
  )

  for (const [family, variants] of byFamily) {
    const parsed = cache.get(family)!

    for (const variant of variants) {
      const tag = tagOf(variant.id)
      // Prefer the tag's own card over the family default — the first info
      // line on the page describes the default tag only, and other tags can
      // differ (gemma4:latest is 128K while gemma4:12b..:31b are 256K).
      const card = cardFor(parsed, variant.id)
      models.push({
        id: variant.id,
        name: titleCase(family) + (tag ? ` (${tag})` : ""),
        created: variant.created,
        family,
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

  const resolved = resolveCatalog(merged, {
    seed,
    overrides: await loadOverrides(),
    today: new Date().toISOString().slice(0, 10),
  })
  for (const w of resolved.warnings) console.warn(`warning: ${w}`)

  const quantized = await enrichQuantization(resolved.models, catalog)

  const next: Catalog = {
    ...catalog,
    generatedAt: new Date().toISOString(),
    modelsHash: liveHash,
    // /v1/models returns tags in no stable order and some share a created
    // timestamp (gpt-oss:120b/:20b); the id tiebreak keeps regenerations of an
    // unchanged model list from producing a reordered — and thus "changed" —
    // catalog.
    models: quantized
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)),
  }

  // Atomic: a torn write must never leave a half-catalog that wedges every
  // subsequent `update` and `check` run.
  await Bun.write(CATALOG_PATH + ".tmp", JSON.stringify(next, null, 2) + "\n")
  await rename(CATALOG_PATH + ".tmp", CATALOG_PATH)
  console.log(
    `catalog updated: ${quantized.length} models, ${byFamily.size} families scraped, ${resolved.warnings.length} pricing warnings, ${quantized.filter((m) => m.quantization === QUANT_UNKNOWN).length} quantization unknown`,
  )
}

// Guarded so tests and the validator can import pure functions (parseLibraryPage,
// titleCase) without triggering an update run.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

// Quantization enrichment (ticket 06): registry manifest <ref>-cloud → config
// blob as primary source, POST /api/show as witness. CI advises (warnings),
// never fails: an unreachable registry leaves the previous catalog value
// intact via resolveQuantization's outage policy.
const QUANT_CONCURRENCY = 6

async function enrichQuantization(models: CatalogModel[], previous: Catalog): Promise<CatalogModel[]> {
  const prevById = new Map(previous.models.map((m) => [m.id, m]))
  const slots = new Array<QuantizationResult>(models.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(QUANT_CONCURRENCY, models.length) }, async () => {
      while (cursor < models.length) {
        const index = cursor++
        const model = models[index]
        const prevRow = prevById.get(model.id)
        let registry: string | null = null
        let registryFailed = false
        try {
          const manifest = await fetchJson<{ config?: { digest?: string } }>(
            REGISTRY_MANIFEST_URL(model.family, cloudRefFor(model.id)),
          )
          const digest = manifest?.config?.digest
          if (typeof digest === "string" && digest.length > 0) {
            const blob = await fetchJson<unknown>(REGISTRY_BLOB_URL(model.family, digest))
            registry = fileTypeFromBlob(blob)
          }
        } catch {
          registryFailed = true
        }
        let show: string | null = null
        try {
          const res = await fetch(SHOW_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": "opencode-ollama-cloud-updater",
            },
            body: JSON.stringify({ model: model.id }),
            signal: AbortSignal.timeout(20_000),
          })
          if (res.ok) show = quantizationFromShow(await res.json())
        } catch {
          /* witness unavailable — no conflict, just no second voice */
        }
        slots[index] = resolveQuantization({
          id: model.id,
          registry,
          registryFailed,
          show,
          previous: prevRow?.quantization ?? null,
        })
      }
    }),
  )

  const warnings: string[] = []
  const enriched = models.map((m, index) => {
    const q = slots[index] ?? { quantization: QUANT_UNKNOWN, source: "no defensible source" }
    if (q.conflict)
      warnings.push(
        `${m.id}: quantization conflict — registry ${String(q.conflict.registry)} vs /api/show ${String(q.conflict["api/show"])} (registry wins)`,
      )
    if (q.warning)
      warnings.push(`${q.warning}: registry file_type came back empty — keeping the previous catalog value (check for an Ollama-side change)`)
    return {
      ...m,
      quantization: q.quantization,
      sources: { ...m.sources, quantization: q.source },
      ...(q.conflict ? { conflicts: { ...m.conflicts, quantization: q.conflict } } : {}),
    }
  })
  for (const w of warnings) console.warn(`warning: ${w}`)
  return enriched
}