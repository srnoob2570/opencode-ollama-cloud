import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROVIDER_ID = "ollama-cloud";

/** Normalized catalog model — the plugin's internal view, independent of the
 * artifact's shape. Only the fields the opencode model record consumes
 * survive normalization. */
export interface CatalogModel {
  id: string;
  name: string;
  capabilities: { tools: boolean; thinking: boolean; vision: boolean };
  context: number;
  maxOutput: number;
  reasoningOptions: string[];
  releaseDate: string;
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

export interface PluginOpts {
  catalogUrl?: string;
  timeoutMs?: number;
}

/** The served shape of one artifact entry — the loader's view AFTER the
 * per-entry gate (usableModels) has passed it. Wire optionality the gate
 * does not enforce stays in the types: the cost fields (adoption is
 * all-or-nothing in toCatalogModel) and the decision marker (checked
 * before the gate, inside usableModels). */
export interface ArtifactModel {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  /** Cost is optional on the wire (third-party catalogs, deliberately
   * unpriced promos) and so are its fields: a decision model publishes
   * input-only because its output tokens are free. toCatalogModel adopts
   * the block only when complete and sane — never a partial price. */
  cost?: { input: number; output?: number; cache_read?: number };
  /** limit.output is required to serve: the gate enforces it, so
   * normalization can trust it. Decision models omit it by design (they
   * never serve /api/chat) and never pass the gate. */
  limit: { context: number; output: number };
  modalities: { input: string[] };
  release_date: string;
  x_ollama?: {
    reasoning_options?: unknown[];
    /** True only on decision models (served via /v1/systemone, not
     * /api/chat). The artifact's marker is the contract: usableModels
     * excludes them — opencode cannot use them. */
    decision?: boolean;
  };
}

/** Envelope-validated document (isCatalog checks the provider block, the
 * x_ollama meta, and that models is a record). The VALUES of models are
 * only known-good after usableModels gates each entry — this type
 * describes the served shape; the gate enforces it at runtime. */
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

/** Positive finite number — the invariant every input rate must carry. */
const positiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Nonnegative finite number — output/cache_read rates accept 0: free
 * tokens are a legitimate published price (a decision model's output and
 * cache cells publish as $0). Input must stay positive (positiveFinite). */
const nonnegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Loader-side ENVELOPE check of the published artifact: provider block,
 * x_ollama meta, and that models is a record. Per-model validation is
 * deliberately NOT here — it lives in usableModels, which drops or skips
 * individual entries. The beam incident fixed the invariant: one malformed
 * entry (clef:27b publishing no limit.output) must never hide the good
 * models behind it by rejecting the whole document. Extra fields
 * (peak_cost, parameter_count, ollama_family, modalities.output, status,
 * description…) pass unchecked: the published schema is the stricter
 * contract, the loader only guards its own reads. The $schema pointer is
 * metadata, not validated. */
export function isCatalog(value: unknown): value is ArtifactDoc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  const provider = doc.provider as Record<string, unknown> | undefined;
  const meta = doc.x_ollama as Record<string, unknown> | undefined;
  const models = provider?.models as Record<string, unknown> | undefined;
  return (
    isNonEmptyString(provider?.id) &&
    isNonEmptyString(provider?.name) &&
    isNonEmptyString(provider?.npm) &&
    isNonEmptyString(provider?.doc) &&
    Array.isArray(provider?.env) &&
    provider.env.every((v) => typeof v === "string") &&
    typeof models === "object" &&
    models !== null &&
    !Array.isArray(models) &&
    isNonEmptyString(meta?.generated_at) &&
    // sha256 gate fingerprint (catalog.schema.json: ^[0-9a-f]{64}$)
    typeof meta?.models_hash === "string" &&
    /^[0-9a-f]{64}$/.test(meta.models_hash)
  );
}

/** Per-entry gate: everything opencode needs to SERVE the model. Mirrors
 * the fields the plugin consumes — id/name/flags/limits/modalities/
 * release_date, plus the x_ollama shapes toCatalogModel reads (no closed
 * enum: a new Ollama format must not break the loader). Cost is NOT
 * checked here: it is optional metadata, and its adoption is all-or-nothing
 * in toCatalogModel. Type predicate: an ArtifactModel claim is only sound
 * after this passes. */
function usableEntry(raw: unknown): raw is ArtifactModel {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  const limit = m.limit as Record<string, unknown> | undefined;
  const modalities = m.modalities as Record<string, unknown> | undefined;
  const x = m.x_ollama as Record<string, unknown> | undefined;
  // schema requires >= 1; a bare typeof check would accept context: 0 or
  // output: 0 and serve a broken model. Decision models publish no
  // limit.output — they cannot serve /api/chat and stay out.
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
    // consumed downstream as the record's release date, a required string
    isNonEmptyString(m.release_date) &&
    (x === undefined ||
      // shape-only: non-string entries are dropped by the adapter so garbage
      // effort keys never reach the model record or a 400 upstream
      x.reasoning_options === undefined ||
      Array.isArray(x.reasoning_options))
  );
}

/** Artifact entries → the models opencode can actually use. Decision
 * models (x_ollama.decision: true — served via /v1/systemone, not
 * /api/chat) are excluded silently: the artifact's marker is the
 * contract. Any other entry failing the served-shape gate is dropped
 * with a warning — one broken entry never hides the good ones (the beam
 * incident); the rest of the document still loads. */
export function usableModels(models: Record<string, unknown>): CatalogModel[] {
  const usable: CatalogModel[] = [];
  for (const [key, raw] of Object.entries(models)) {
    const x = (raw as { x_ollama?: { decision?: unknown } } | null)?.x_ollama;
    if (x?.decision === true) continue;
    if (!usableEntry(raw)) {
      console.warn(
        `opencode-ollama-cloud: dropping unusable catalog entry "${key}"`,
      );
      continue;
    }
    usable.push(toCatalogModel(raw));
  }
  return usable;
}

/** All-or-nothing cost adoption: the artifact's cost block is one claim
 * ("these are the prices"), so a partial or malformed block adopts
 * nothing — the model stays rateless ($0, the documented safe default),
 * never a wrong price. output and cache_read accept 0: free tokens are a
 * legitimate published rate. */
function adoptCost(m: ArtifactModel): PricingRate | undefined {
  const c = m.cost;
  if (!c) return undefined;
  if (!positiveFinite(c.input) || !nonnegativeFinite(c.output))
    return undefined;
  if (c.cache_read !== undefined && !nonnegativeFinite(c.cache_read)) {
    return undefined;
  }
  const rate: PricingRate = { input: c.input, output: c.output };
  if (c.cache_read !== undefined) rate.cachedInput = c.cache_read;
  return rate;
}

/** Artifact entry → normalized CatalogModel. Only fields the plugin
 * consumes survive; everything else (peak_cost, parameter_count,
 * ollama_family, quantization, modalities.output) stays in the artifact.
 * Exported as the normalization seam (tests + a custom loader could reuse
 * it). */
export function toCatalogModel(m: ArtifactModel): CatalogModel {
  const model: CatalogModel = {
    id: m.id,
    name: m.name,
    capabilities: {
      tools: m.tool_call,
      thinking: m.reasoning,
      vision: m.attachment || m.modalities.input.includes("image"),
    },
    context: m.limit.context,
    maxOutput: m.limit.output,
    reasoningOptions: (m.x_ollama?.reasoning_options ?? []).filter(
      (option): option is string => typeof option === "string",
    ),
    releaseDate: m.release_date,
  };
  const cost = adoptCost(m);
  if (cost) model.cost = cost;
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
): Promise<CatalogModel[] | null> {
  // A user-configured URL keeps documented priority ("tried first") over
  // the defaults.
  const urls = opts.catalogUrl
    ? [opts.catalogUrl, ...DEFAULT_URLS]
    : DEFAULT_URLS;
  const doc = await loadValidated(urls, CACHE_FILE, isCatalog, opts);
  if (!doc) return null;
  // isCatalog guarantees the envelope only; usableModels gates each entry
  // (decision models excluded, broken entries dropped) before
  // normalization. Pricing rides INSIDE the catalog (each entry's cost
  // block) — a costless or partially-costed entry normalizes rateless
  // ($0), the rateless contract preserved.
  return usableModels(doc.provider.models);
}
