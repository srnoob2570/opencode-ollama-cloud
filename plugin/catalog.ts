import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** Reference price of the upstream API (USD per 1M tokens) — not billing. */
  pricing?: ModelPricing;
  /** Per-field provenance: which source provided each value. */
  sources?: Record<string, string>;
  /** Recorded disagreements between sources, with the resolver applied. */
  conflicts?: Record<string, Record<string, unknown>>;
}

export interface ModelPricing {
  input: number;
  output: number;
  /** Our updater always sets "per-1M"; foreign catalogs may omit it. */
  unit?: "per-1M";
  provider?: string;
  source?: string;
  asOf?: string;
  note?: string;
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

export interface PluginOpts {
  catalogUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_URLS = [
  "https://cdn.jsdelivr.net/gh/srnoob2570/opencode-ollama-cloud@main/catalog/catalog.json",
  "https://raw.githubusercontent.com/srnoob2570/opencode-ollama-cloud/main/catalog/catalog.json",
];

const CACHE_DIR = join(homedir(), ".cache", "opencode-ollama-cloud");
const CACHE_FILE = join(CACHE_DIR, "catalog.json");

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
        // optional blocks: absent → always valid; present → the plugin costs
        // only read input/output, so the loader requires those (finite,
        // positive) plus a valid unit if one is set — a minimal models.dev-
        // shaped {input, output} pricing from a custom catalogUrl keeps
        // loading. The published schema (catalog.schema.json) is stricter.
        (!m.pricing ||
          // Pricing invariant: positive finite input/output — the same rule
          // lives in resolve-catalog.ts (realCost/isOverride) and
          // catalog.schema.json (exclusiveMinimum 0). Keep all three in sync.
          (Number.isFinite(m.pricing.input) &&
            m.pricing.input > 0 &&
            Number.isFinite(m.pricing.output) &&
            m.pricing.output > 0 &&
            (m.pricing.unit === undefined || m.pricing.unit === "per-1M"))) &&
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

async function readCache(): Promise<Catalog | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return isCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(catalog: Catalog): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(catalog));
  } catch {
    /* cache is best-effort */
  }
}

export async function loadCatalog(
  opts: PluginOpts = {},
): Promise<Catalog | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;

  // A user-configured URL keeps documented priority ("tried first") over the defaults.
  if (opts.catalogUrl) {
    const data = await fetchCatalogJson(opts.catalogUrl, timeoutMs);
    if (isCatalog(data)) {
      void writeCache(data);
      return data;
    }
  }

  // Race the default mirrors in parallel: first response passing validation wins.
  // Sequential tries cost up to urls.length * timeoutMs on a network outage before
  // falling back to the disk cache. The promise only resolves with a Catalog that
  // already passed isCatalog (or null), so no re-validation is needed after.
  const data = await new Promise<Catalog | null>((resolve) => {
    let pending = DEFAULT_URLS.length;
    let settled = false;
    for (const url of DEFAULT_URLS) {
      void fetchCatalogJson(url, timeoutMs).then((d) => {
        if (settled) return;
        if (isCatalog(d)) {
          settled = true;
          resolve(d);
        } else if (--pending === 0) {
          resolve(null);
        }
      });
    }
  });

  if (data) {
    void writeCache(data);
    return data;
  }
  return readCache();
}
