// Quantization resolver — pure curation seam of ticket 06, mirroring
// resolve-catalog.ts's style: the caller passes already-fetched data; no
// network, no filesystem.
//
// Contract (wayfinder ticket "contrato del schema de cuantización"): the
// catalog carries the RAW value Ollama exposes — the registry config blob's
// `file_type`, identical to /api/show's details.quantization_level (verified
// 19/19, research/cuantizacion-por-modelo.md) — or the literal "unknown".
// `file_type` is DECLARATIVE metadata of the served model ("shown as
// Quantization Level" in ollama's types/model/config.go): never a guarantee
// of the remote inference precision.
//
// Priority: registry > implicit (researched) > previous run. The /api/show
// witness never overrides; it only raises a visible conflict (CI warns, never
// fails — the repo's source-policy).

export const REGISTRY_MANIFEST_URL = (family: string, ref: string) =>
  `https://registry.ollama.ai/v2/library/${family}/manifests/${ref}`;
export const REGISTRY_BLOB_URL = (family: string, digest: string) =>
  `https://registry.ollama.ai/v2/library/${family}/blobs/${digest}`;
export const SHOW_URL = "https://ollama.com/api/show";

export const QUANT_UNKNOWN = "unknown";

// Manifest reference convention (verified 19/19): "<tag>-cloud" for tagged
// ids, plain "cloud" (alias of latest-cloud) for tagless ones. The bare
// /manifests/cloud path only exists for flagship families — the tag-suffixed
// reference reaches all 19, including gpt-oss / mistral-large-3 /
// nemotron-3-nano that the pricing-era map could not resolve.
export const cloudRefFor = (id: string): string => {
  const tag = id.includes(":") ? id.split(":")[1] : "";
  return tag ? `${tag}-cloud` : "cloud";
};

/** The config blob's `file_type` — a raw string ("FP8", ""…) — null otherwise. */
export function fileTypeFromBlob(blob: unknown): string | null {
  if (typeof blob !== "object" || blob === null) return null;
  const value: unknown = (blob as Record<string, unknown>).file_type;
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

/** /api/show's details.quantization_level — raw string, null when absent/empty. */
export function quantizationFromShow(show: unknown): string | null {
  if (typeof show !== "object" || show === null) return null;
  const details = (show as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return null;
  const value: unknown = (details as Record<string, unknown>)
    .quantization_level;
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

/**
 * Researched implicit values (research/cuantizacion-por-modelo.md): models the
 * registry's blob leaves EMPTY but that carry defensible public evidence.
 * Provenance is stored on the source string so the ficha can show why.
 * minimax-m3 and minimax-m2.7 are deliberately NOT here: contradictory
 * (MXFP8 vs NVFP4 checkpoints) and zero-signal respectively — they resolve to
 * literal "unknown".
 */
export const IMPLICIT_QUANTIZATION: Record<
  string,
  { value: string; source: string }
> = {
  "glm-5.2": {
    value: "FP8",
    source: "implicit-hf (zai-org/GLM-5.2-FP8 checkpoint + glm family FP8)",
  },
  "nemotron-3-ultra": {
    value: "NVFP4",
    source:
      "implicit-library (nemotron-3-ultra library README + NVIDIA checkpoints)",
  },
};

export interface QuantizationInput {
  id: string;
  /** file_type from the registry config blob ("" when the blob is empty). */
  registry?: string | null;
  /** The registry request itself failed (network/404) — enables previous fallback. */
  registryFailed?: boolean;
  /** details.quantization_level from POST /api/show, when reachable. */
  show?: string | null;
  /** Previous catalog row's quantization, for outage-proofing. */
  previous?: string | null;
}

export interface QuantizationResult {
  quantization: string;
  source: string;
  /** Set when the witness disagrees — callers add a CI warning (advises, never fails). */
  conflict?: Record<string, unknown>;
  /** Advisory for the CI log (never a failure). */
  warning?: string;
}

export function resolveQuantization(
  input: QuantizationInput,
): QuantizationResult {
  const registryValue =
    input.registry && input.registry.trim() !== "" ? input.registry : null;
  const showValue = input.show && input.show.trim() !== "" ? input.show : null;

  if (registryValue) {
    if (showValue && showValue !== registryValue) {
      return {
        quantization: registryValue,
        source: "registry-ollama",
        conflict: {
          registry: registryValue,
          "api/show": showValue,
          resolver: "registry-wins",
        },
      };
    }
    return { quantization: registryValue, source: "registry-ollama" };
  }

  // Researched implicit values come BEFORE the previous-run fallback: models
  // like glm-5.2/nemotron-3-ultra have ALWAYS had an empty registry blob, so
  // their implicit provenance is the truth and must not degrade to "previous
  // run" on every refresh.
  const implicit = IMPLICIT_QUANTIZATION[input.id];
  if (implicit)
    return { quantization: implicit.value, source: implicit.source };

  // Never publish a silent regression to "unknown": if the previous catalog
  // carried a value, keep it whether the registry is unreachable OR reachable
  // but now empty. The source label marks it and the warning tells CI to look.
  if (input.previous && input.previous !== QUANT_UNKNOWN) {
    if (input.registryFailed)
      return {
        quantization: input.previous,
        source: "registry-ollama (previous run)",
      };
    // registry answered but with an empty/absent file_type — a data change
    return {
      quantization: input.previous,
      source: "registry-ollama (previous run, blob empty now)",
      warning: input.id,
    };
  }

  return { quantization: QUANT_UNKNOWN, source: "no defensible source" };
}
