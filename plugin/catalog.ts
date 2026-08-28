import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER_ID = "ollama-cloud"

/** Single source of truth for the provider identity (kept in sync with catalog.schema.json). */
export const PROVIDER_CONFIG: Catalog["provider"] = {
  id: PROVIDER_ID,
  name: "Ollama Cloud",
  api: "https://ollama.com/v1",
  npm: "@ai-sdk/openai-compatible",
  env: ["OLLAMA_API_KEY"],
}

export interface CatalogModel {
  id: string
  name: string
  created: number
  family: string
  capabilities: { tools: boolean; thinking: boolean; vision: boolean }
  input: string[]
  context: number
  maxOutput: number
  reasoningOptions: string[]
  releaseDate: string
}

export interface Catalog {
  provider: {
    id: string
    name: string
    api: string
    npm: string
    env: string[]
  }
  generatedAt: string
  modelsHash: string
  models: CatalogModel[]
}

export interface PluginOpts {
  catalogUrl?: string
  timeoutMs?: number
}

const DEFAULT_URLS = [
  "https://cdn.jsdelivr.net/gh/srnoob2570/opencode-ollama-cloud@main/catalog/catalog.json",
  "https://raw.githubusercontent.com/srnoob2570/opencode-ollama-cloud/main/catalog/catalog.json",
]

const CACHE_DIR = join(homedir(), ".cache", "opencode-ollama-cloud")
const CACHE_FILE = join(CACHE_DIR, "catalog.json")

function isCatalog(value: unknown): value is Catalog {
  if (typeof value !== "object" || value === null) return false
  const c = value as Catalog
  return (
    typeof c.provider?.id === "string" &&
    typeof c.provider?.api === "string" &&
    typeof c.provider?.npm === "string" &&
    Array.isArray(c.models) &&
    c.models.every(
      (m) =>
        typeof m?.id === "string" &&
        typeof m?.name === "string" &&
        typeof m?.created === "number" &&
        typeof m?.context === "number" &&
        typeof m?.maxOutput === "number" &&
        typeof m?.capabilities?.tools === "boolean" &&
        typeof m?.capabilities?.thinking === "boolean" &&
        typeof m?.capabilities?.vision === "boolean" &&
        Array.isArray(m?.input),
    )
  )
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function readCache(): Promise<Catalog | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8")
    const parsed = JSON.parse(raw)
    return isCatalog(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeCache(catalog: Catalog): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(catalog))
  } catch {
    /* cache is best-effort */
  }
}

export async function loadCatalog(opts: PluginOpts = {}): Promise<Catalog | null> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const urls = opts.catalogUrl ? [opts.catalogUrl, ...DEFAULT_URLS] : DEFAULT_URLS

  for (const url of urls) {
    const data = await fetchJson(url, timeoutMs)
    if (isCatalog(data)) {
      void writeCache(data)
      return data
    }
  }
  return readCache()
}