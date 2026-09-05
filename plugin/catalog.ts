import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROVIDER_ID = "ollama-cloud";

/** Single source of truth for the provider identity. Deliberately decoupled
 * from the artifact: a third-party catalog (custom catalogUrl) carries its
 * own provider block, and the plugin must never adopt it. */
export interface ProviderConfig {
  id: string;
  name: string;
  api: string;
  npm: string;
  env: string[];
}

export const PROVIDER_CONFIG: ProviderConfig = {
  id: PROVIDER_ID,
  name: "Ollama Cloud",
  api: "https://ollama.com/v1",
  npm: "@ai-sdk/openai-compatible",
  env: ["OLLAMA_API_KEY"],
};

/** Normalized catalog model — the plugin's internal view, independent of the
 * artifact's shape. `family` is the id base (familia[:tag], CONTEXT.md
 * vocabulary); the registry ollama_family stays inside the artifact. */
export interface CatalogModel {
  id: string;
  name: string;
  family: string;
  capabilities: { tools: boolean; thinking: boolean; vision: boolean };
  input: string[];
  context: number;
  maxOutput: number;
  reasoningOptions: string[];
  releaseDate: string;
  /** Raw quantization Ollama declares for the served model (/api/show
   * quantization_level) — or the literal "unknown". DECLARATIVE metadata,
   * never a guarantee of remote inference precision. No closed enum: a new
   * Ollama format must not break the loader. */
  quantization?: string;
  /** Official Ollama Cloud rate (USD per 1M tokens) from the artifact's
   * cost block — what the credits actually pay (off-peak rates; peak rates
   * live under the artifact's x_ollama.peak_cost and are not shown). */
  cost?: PricingRate;
}

/** Official Ollama Cloud rate for one model (USD per 1M tokens). */
export interface PricingRate {
  input: number;
  output: number;
  /** Rate card's "Cached input" column — feeds opencode's cache.read. */
  cachedInput?: number;
}

export interface Catalog {
  generatedAt: string;
  modelsHash: string;
  models: CatalogModel[];
}

export interface PluginOpts {
  catalogUrl?: string;
  timeoutMs?: number;
}

/** The published artifact (models.dev shape plus the x_ollama extension),
 * the loader's view before normalization. */
export interface ArtifactModel {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  cost?: { input: number; output: number; cache_read?: number };
  limit: { context: number; output: number };
  modalities: { input: string[] };
  release_date: string;
  x_ollama?: {
    quantization?: string;
    reasoning_options?: unknown[];
  };
}

export interface ArtifactDoc {
  provider: {
    id: string;
    name: string;
    npm: string;
    doc: string;
    env: string[];
    models: Record<string, ArtifactModel>;
  };
  x_ollama: { generated_at: string; models_hash: string };
}

// The artifact lives in its own repo (ollama-cloud-catalog): hash-gated
// catalog built from /v1/models + /api/show + the rate card, published by
// scheduled GitHub Actions. Two mirrors, same file at the repo root.
const DEFAULT_URLS = [
  "https://cdn.jsdelivr.net/gh/srnoob2570/ollama-cloud-catalog@main/catalog.json",
  "https://raw.githubusercontent.com/srnoob2570/ollama-cloud-catalog/main/catalog.json",
];

const CACHE_DIR = join(homedir(), ".cache", "opencode-ollama-cloud");
const CACHE_FILE = join(CACHE_DIR, "catalog.json");

/** Positive finite number — the invariant every cost value must carry. */
const positiveFinite = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Loader-side shape check of the published artifact. It mirrors
 * schemas/catalog.schema.json on the fields the plugin CONSUMES — extra
 * fields (peak_cost, parameter_count, ollama_family, modalities.output,
 * status, description…) pass unchecked: the published schema is the
 * stricter contract, the loader only guards its own reads. The $schema
 * pointer is metadata, not validated. */
export function isCatalog(value: unknown): value is ArtifactDoc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  const provider = doc.provider as Record<string, unknown> | undefined;
  const meta = doc.x_ollama as Record<string, unknown> | undefined;
  const models = provider?.models as Record<string, unknown> | undefined;
  if (
    !isNonEmptyString(provider?.id) ||
    !isNonEmptyString(provider?.name) ||
    !isNonEmptyString(provider?.npm) ||
    !isNonEmptyString(provider?.doc) ||
    !Array.isArray(provider?.env) ||
    !provider.env.every((v) => typeof v === "string") ||
    typeof models !== "object" ||
    models === null ||
    Array.isArray(models) ||
    !isNonEmptyString(meta?.generated_at) ||
    // sha256 gate fingerprint (catalog.schema.json: ^[0-9a-f]{64}$)
    typeof meta?.models_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(meta.models_hash)
  )
    return false;

  return Object.values(models).every((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const m = raw as Record<string, unknown>;
    const limit = m.limit as Record<string, unknown> | undefined;
    const modalities = m.modalities as Record<string, unknown> | undefined;
    const cost = m.cost as Record<string, unknown> | undefined;
    const x = m.x_ollama as Record<string, unknown> | undefined;
    // schema requires >= 1; a bare typeof check would accept context: 0
    // and serve a broken model
    return (
      isNonEmptyString(m.id) &&
      isNonEmptyString(m.name) &&
      typeof m.attachment === "boolean" &&
      typeof m.reasoning === "boolean" &&
      typeof m.tool_call === "boolean" &&
      typeof limit?.context === "number" &&
      limit.context >= 1 &&
      typeof limit?.output === "number" &&
      limit.output >= 1 &&
      isStringArray(modalities?.input) &&
      // consumed downstream as ModelV2.release_date, a required string
      isNonEmptyString(m.release_date) &&
      (cost === undefined ||
        (positiveFinite(cost.input) &&
          positiveFinite(cost.output) &&
          (cost.cache_read === undefined ||
            positiveFinite(cost.cache_read)))) &&
      (x === undefined ||
        ((x.quantization === undefined ||
          (typeof x.quantization === "string" && x.quantization.length > 0)) &&
          // shape-only: non-string entries are dropped by the adapter so
          // garbage effort keys never reach the TUI picker or a 400 upstream
          (x.reasoning_options === undefined ||
            Array.isArray(x.reasoning_options))))
    );
  });
}

/** Catalog family = id base (familia[:tag], CONTEXT.md vocabulary). */
const familyOf = (id: string): string => {
  const tag = id.indexOf(":");
  return tag === -1 ? id : id.slice(0, tag);
};

/** Artifact entry → normalized CatalogModel. Only fields the plugin
 * consumes survive; everything else (peak_cost, parameter_count,
 * ollama_family, modalities.output) stays in the artifact. Exported as the
 * normalization seam (tests + a custom loader could reuse it). */
export function toCatalogModel(m: ArtifactModel): CatalogModel {
  const model: CatalogModel = {
    id: m.id,
    name: m.name,
    family: familyOf(m.id),
    capabilities: {
      tools: m.tool_call,
      thinking: m.reasoning,
      vision: m.attachment || m.modalities.input.includes("image"),
    },
    input: m.modalities.input,
    context: m.limit.context,
    maxOutput: m.limit.output,
    reasoningOptions: (m.x_ollama?.reasoning_options ?? []).filter(
      (option): option is string => typeof option === "string",
    ),
    releaseDate: m.release_date,
  };
  if (m.x_ollama?.quantization) model.quantization = m.x_ollama.quantization;
  if (m.cost) {
    model.cost = { input: m.cost.input, output: m.cost.output };
    if (m.cost.cache_read !== undefined) {
      model.cost.cachedInput = m.cost.cache_read;
    }
  }
  return model;
}

// Runtime-side fetch: best-effort (null on any failure) — the plugin must
// never throw on a down CDN. The catalog repo's updater is intentionally the
// opposite (fail loud) because CI should block on errors.
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

// Mirror-race loader: fetch every mirror in parallel, the first response
// passing validation wins. Sequential tries would cost up to urls.length *
// timeoutMs on a network outage before falling back to the disk cache. The
// promise only resolves with data that already passed the validator (or
// null), so no re-validation is needed after.
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
  // A user-configured URL keeps documented priority ("tried first") over
  // the defaults.
  const urls = opts.catalogUrl
    ? [opts.catalogUrl, ...DEFAULT_URLS]
    : DEFAULT_URLS;
  const doc = await loadValidated(urls, CACHE_FILE, isCatalog, opts);
  if (!doc) return null;
  // isCatalog has already validated every entry's shape; normalization only
  // projects the consumed fields. Pricing rides INSIDE the catalog (each
  // entry's cost block) — a third-party catalog without cost fields simply
  // normalizes rateless ($0), the rateless contract preserved.
  return {
    generatedAt: doc.x_ollama.generated_at,
    modelsHash: doc.x_ollama.models_hash,
    models: Object.values(doc.provider.models).map(toCatalogModel),
  };
}
