import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROVIDER_ID = "ollama-cloud";

/** Single source of truth for the provider identity (kept in sync with catalog.schema.json). */
export const PROVIDER_CONFIG: Catalog["provider"] = {
  id: PROVIDER_ID,
  name: "Ollama Cloud",
  api: "https://ollama.com/v1",
  npm: "@ai-sdk/openai-compatible",
  env: ["OLLAMA_API_KEY"],
};

export interface CatalogModel {
  id: string;
  name: string;
  created: number;
  family: string;
  capabilities: { tools: boolean; thinking: boolean; vision: boolean };
  input: string[];
  context: number;
  maxOutput: number;
  reasoningOptions: string[];
  releaseDate: string;
  /** Raw quantization Ollama declares for the served model (registry file_type
   * + /api/show quantization_level) — or the literal "unknown". DECLARATIVE
   * metadata, never a guarantee of remote inference precision. No closed enum:
   * a new Ollama format must not block the updater. */
  quantization?: string;
  /** Per-field provenance: which source provided each value. */
  sources?: Record<string, string>;
  /** Recorded disagreements between sources, with the resolver applied. */
  conflicts?: Record<string, Record<string, unknown>>;
}

export interface Catalog {
  provider: {
    id: string;
    name: string;
    api: string;
    npm: string;
    env: string[];
  };
  generatedAt: string;
  modelsHash: string;
  models: CatalogModel[];
}

/** Official Ollama Cloud rate for one model (USD per 1M tokens), from the
 * public rate card (ollama.com/pricing) — what the credits actually pay,
 * not an upstream reference. Lives in catalog/pricing.json, regenerated
 * only by the manual update-pricing workflow. */
export interface PricingRate {
  input: number;
  output: number;
  /** Rate card's "Cached input" column — feeds opencode's cache.read. */
  cachedInput?: number;
  unit?: "per-1M";
  source?: string;
  asOf?: string;
}

export type PricingTable = Record<string, PricingRate>;

export interface PluginOpts {
  catalogUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_URLS = [
  "https://cdn.jsdelivr.net/gh/srnoob2570/opencode-ollama-cloud@main/catalog/catalog.json",
  "https://raw.githubusercontent.com/srnoob2570/opencode-ollama-cloud/main/catalog/catalog.json",
];

const DEFAULT_PRICING_URLS = [
  "https://cdn.jsdelivr.net/gh/srnoob2570/opencode-ollama-cloud@main/catalog/pricing.json",
  "https://raw.githubusercontent.com/srnoob2570/opencode-ollama-cloud/main/catalog/pricing.json",
];

const CACHE_DIR = join(homedir(), ".cache", "opencode-ollama-cloud");
const CACHE_FILE = join(CACHE_DIR, "catalog.json");
const PRICING_CACHE_FILE = join(CACHE_DIR, "pricing.json");

export function isPricingTable(value: unknown): value is PricingTable {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  // Loader-side shape check mirrors pricing.schema.json (the published,
  // stricter contract): positive-finite input/output/cachedInput — the same
  // invariant the rate card's rows carry. Optional blocks absent → valid.
  // The $schema pointer is metadata (same as catalog.json's), not an entry.
  return Object.entries(value)
    .filter(([key]) => key !== "$schema")
    .every(
      ([, r]) =>
        typeof r?.input === "number" &&
        Number.isFinite(r.input) &&
        r.input > 0 &&
        typeof r?.output === "number" &&
        Number.isFinite(r.output) &&
        r.output > 0 &&
        (r.cachedInput === undefined ||
          (Number.isFinite(r.cachedInput) && r.cachedInput > 0)) &&
        (r.unit === undefined || r.unit === "per-1M") &&
        (r.source === undefined || typeof r.source === "string") &&
        (r.asOf === undefined || typeof r.asOf === "string"),
    );
}

// Coverage is a cross-check between the two contract sides (table ↔ catalog),
// shared by the validator (CI) and the manual update-pricing workflow so the
// rule cannot drift apart: every rate needs a catalog model, every catalog
// model needs a rate. The plugin does NOT enforce this at runtime — it
// tolerates partial tables ($0 for unknown models) by contract; callers
// decide the severity (the manual workflow aborts on any problem; CI warns,
// because blocking publish would deadlock the scheduled update until the
// owner runs update-pricing).
export function pricingCoverageProblems(
  table: PricingTable,
  catalogIds: string[],
): { orphanRates: string[]; missingRates: string[] } {
  const catalogSet = new Set(catalogIds);
  const orphanRates = Object.keys(table)
    .filter((id) => id !== "$schema" && !catalogSet.has(id))
    .map(
      (id) =>
        `rates "${id}", which is not in the catalog (typo or retired model? run update-catalog, then update-pricing)`,
    );
  const missingRates = catalogIds
    .filter((id) => !(id in table))
    .map(
      (id) =>
        `catalog model "${id}" has no rate on the pricing page (run bun run update-pricing)`,
    );
  return { orphanRates, missingRates };
}

export function isCatalog(value: unknown): value is Catalog {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Catalog;
  return (
    typeof c.provider?.id === "string" &&
    typeof c.provider?.name === "string" &&
    typeof c.provider?.api === "string" &&
    typeof c.provider?.npm === "string" &&
    Array.isArray(c.provider?.env) &&
    Array.isArray(c.models) &&
    c.models.every(
      (m) =>
        typeof m?.id === "string" &&
        typeof m?.name === "string" &&
        typeof m?.created === "number" &&
        typeof m?.family === "string" &&
        // schema requires >= 1; a bare typeof check would accept context: 0
        // (what a library-page parse failure produces) and serve a broken model
        typeof m?.context === "number" &&
        m.context >= 1 &&
        typeof m?.maxOutput === "number" &&
        m.maxOutput >= 1 &&
        typeof m?.capabilities?.tools === "boolean" &&
        typeof m?.capabilities?.thinking === "boolean" &&
        typeof m?.capabilities?.vision === "boolean" &&
        Array.isArray(m?.input) &&
        Array.isArray(m?.reasoningOptions) &&
        // consumed downstream as ModelV2.release_date, a required string
        typeof m?.releaseDate === "string" &&
        (m.sources === undefined || typeof m.sources === "object") &&
        (m.conflicts === undefined || typeof m.conflicts === "object") &&
        // optional quantization: absent (old catalogs) is fine; a present one
        // is shape-only (non-empty string) — never an enum, so a new Ollama
        // format cannot break the loader (CI advises, never fails)
        (m.quantization === undefined ||
          (typeof m.quantization === "string" && m.quantization.length > 0)),
    )
  );
}

// Runtime-side fetch: best-effort (null on any failure) — the plugin must
// never throw on a down CDN. scripts/update-catalog.ts's fetchJson is
// intentionally the opposite (fail loud) because CI should block on errors.
async function fetchCatalogJson(
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Shared best-effort cache pair: disk errors are swallowed (cache is
// optional by contract), data is written and read back only if it validates.
async function readCacheFile<T>(
  path: string,
  validate: (v: unknown) => v is T,
): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCacheFile(path: string, data: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data));
  } catch {
    /* cache is best-effort */
  }
}

// Shared mirror-race loader behind loadCatalog and loadPricing: fetch every
// mirror in parallel, the first response passing validation wins. Sequential
// tries would cost up to urls.length * timeoutMs on a network outage before
// falling back to the disk cache. The promise only resolves with data that
// already passed the validator (or null), so no re-validation is needed after.
async function loadValidated<T>(
  urls: string[],
  cacheFile: string,
  validate: (v: unknown) => v is T,
  opts: PluginOpts,
): Promise<T | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const data = await new Promise<T | null>((resolve) => {
    let pending = urls.length;
    let settled = false;
    for (const url of urls) {
      void fetchCatalogJson(url, timeoutMs).then((d) => {
        if (settled) return;
        if (d !== null && validate(d)) {
          settled = true;
          resolve(d);
        } else if (--pending === 0) {
          resolve(null);
        }
      });
    }
  });

  if (data) {
    void writeCacheFile(cacheFile, data);
    return data;
  }
  return readCacheFile(cacheFile, validate);
}

export async function loadCatalog(
  opts: PluginOpts = {},
): Promise<Catalog | null> {
  // A user-configured URL keeps documented priority ("tried first") over the defaults.
  if (opts.catalogUrl) {
    const data = await fetchCatalogJson(
      opts.catalogUrl,
      opts.timeoutMs ?? 5000,
    );
    if (isCatalog(data)) {
      void writeCacheFile(CACHE_FILE, data);
      return data;
    }
  }
  return loadValidated(DEFAULT_URLS, CACHE_FILE, isCatalog, opts);
}

// The pricing table rides the same CDN mirrors and cache as the catalog.
// A user-configured catalogUrl is a THIRD-PARTY catalog: it carries no table
// of ours, and joining one by id could attach rates to a model set it was
// never written for — custom catalogs run rateless ($0) by contract.
export async function loadPricing(
  opts: PluginOpts = {},
): Promise<PricingTable | null> {
  if (opts.catalogUrl) return null;
  return loadValidated(
    DEFAULT_PRICING_URLS,
    PRICING_CACHE_FILE,
    isPricingTable,
    opts,
  );
}
