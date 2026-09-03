// Pure display helpers for the TUI module (tickets 04/05/07). All formats are
// RATIFIED (wayfinder/prototipo-seccion-estadisticas.mock.md) — this module is
// the string contract; the .tsx module only wires it into opencode's slots.
// Pure by design: testable without opencode, no fs, no time.
import type { HandoffFile } from "./handoff.ts";
import type { SessionSummary, StepMeasurement } from "./stats.ts";

export function formatLiveLine(summary: SessionSummary | null): string {
  if (!summary || summary.steps === 0)
    return "— tok/s · TTFT — ms · Session average";
  return `${summary.avgTps.toFixed(1)} tok/s · TTFT ${Math.round(summary.avgTtftMs)} ms · Session average`;
}

/**
 * Session guard (cross-session staleness): while NO session is active the
 * startup renders carry no session_id, so NOTHING may be shown — a stale file
 * from a previous launch must never surface. And a file for another session
 * is never this window's: one opencode window can never render another
 * session's stats.
 */
export function pickSessionFile(
  file: HandoffFile | null,
  activeSessionID: string | null,
): HandoffFile | null {
  if (!activeSessionID || !file || file.sessionID !== activeSessionID)
    return null;
  return file;
}

/** Relative timestamp for the /stats dialog ("1m ago"), stable format. */
export function formatRelativeAge(ts: number, now: number): string {
  // clamp at 0: a future ts (clock skew; ts is the request start, now is
  // sampled later) must read "now", never a fake "1s ago"
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s === 0) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

const tokensLabel = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k t` : `${n} t`;

/** One row of the /stats dialog's recent responses (steps, newest first). */
export function formatStepRow(step: StepMeasurement, now: number): string {
  const tps =
    step.decodeMs > 0
      ? (step.tokensOut / (step.decodeMs / 1000)).toFixed(1)
      : "—";
  // D1: a single-chunk response has decodeMs ≈ 0 → dash TPS is honest data,
  // so the row carries the "(direct)" tag the event rows used to hold
  const direct = step.source === "wire-nostream" ? " (direct)" : "";
  return `${formatRelativeAge(step.ts, now)}   ${tps} tok/s · TTFT ${Math.round(step.ttftMs)} ms · ${tokensLabel(step.tokensOut)}${direct}`;
}

export const EMPTY_SESSION_LINE =
  "No measured responses yet — the first one fills this in";

/** The /stats dialog body (mock §2): summary block + recent responses. */
export function formatStatsDialogBody(
  summary: SessionSummary,
  steps: readonly StepMeasurement[],
  modelID = "—",
  now = Date.now(),
): string {
  // the session average spans model switches (no per-model breakdown by
  // design), so the header only names the LAST model — it must not claim one
  // model owns the whole session's numbers
  if (summary.steps === 0)
    return `  Session · last model ${modelID}\n\n  ${EMPTY_SESSION_LINE}`;
  const head = [
    `  Session · last model ${modelID}`,
    "",
    `  ${summary.avgTps.toFixed(1)} tok/s · TTFT ${Math.round(summary.avgTtftMs)} ms · Session average`,
    `  ${summary.steps} responses · ${tokensLabel(summary.tokensOutTotal)} output`,
  ];
  const rows = steps.slice(0, 10).map((s) => `  ${formatStepRow(s, now)}`);
  // one blank line between head and rows, only when there are rows to separate
  return [...head, ...(rows.length ? [""] : []), ...rows].join("\n");
}

export interface ModelCard {
  id: string;
  name: string;
  family: string;
  releaseDate: string;
  quantization?: string;
  /** Catalog provenance (sources.quantization) — implicit rows must not be
   * labeled "(declarada)": Ollama does not declare them (code-review finding). */
  quantizationSource?: string;
  context: number;
  maxOutput: number;
  capabilities: { tools: boolean; thinking: boolean; vision: boolean };
  pricing?: {
    input: number;
    output: number;
    cachedInput?: number;
  } | null;
}

/** The /model card (mock §3) — quantization is the protagonist. */
export function formatModelCard(model: ModelCard, pricingOn: boolean): string {
  const implicit = model.quantizationSource?.startsWith("implicit") ?? false;
  const quantization = !model.quantization
    ? "— (unavailable)"
    : model.quantization === "unknown"
      ? "unknown"
      : `${model.quantization} ${implicit ? "(implicit)" : "(declared)"}`;
  const rows = [
    `  Name              ${model.name}                ollama-cloud`,
    `  ${model.id} · family ${model.family} · ${model.releaseDate}`,
    "",
    `  Quantization      ${quantization}`,
    `  Context           ${formatTokens(model.context)} · output ${formatTokens(model.maxOutput)}`,
    `  Capabilities      ${capabilityList(model.capabilities)}`,
    ...(pricingOn
      ? [`  Official rate     ${officialRate(model.pricing)}`]
      : []),
    "",
    implicit
      ? `  quantization researched from public sources. Does`
      : `  quantization declared by Ollama. Does not`,
    `  guarantee the precision actually served.`,
  ];
  return rows.join("\n");
}

// decimal base, matching tokensLabel above (k = 1_000, M = 1_000_000): the
// card and the dialog must not run two different token scales side by side
const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${Math.round(n / 1_000_000)}M`
    : `${Math.round(n / 1_000)}k`;

// Official Ollama Cloud rate — rate card column order: input / cached
// input / output. A missing column renders as "—", never as 0.
const officialRate = (p: ModelCard["pricing"]): string => {
  const money = (n: number | undefined): string =>
    n === undefined ? "—" : `$${n}`;
  return `${money(p?.input)} in · ${money(p?.cachedInput)} cached · ${money(p?.output)} out per 1M`;
};

const capabilityList = (caps: ModelCard["capabilities"]): string => {
  const list: string[] = [];
  if (caps.tools) list.push("tools");
  if (caps.thinking) list.push("thinking");
  if (caps.vision) list.push("vision");
  return list.length ? list.join(" · ") : "—";
};

/**
 * Degradación silenciosa: what the TUI module may touch. Anything missing →
 * the module retires without noise (the provider/catalog must keep working).
 */
export function pickTuiFeatures(api: unknown): {
  slots: boolean;
  keymap: boolean;
} {
  const a = api as
    | { slots?: { register?: unknown }; keymap?: { registerLayer?: unknown } }
    | null
    | undefined;
  return {
    slots: typeof a?.slots?.register === "function",
    keymap: typeof a?.keymap?.registerLayer === "function",
  };
}

/**
 * Pricing knob, shared by BOTH entries so the only-off rule lives in one
 * place (code-review finding): the rate is the OFFICIAL Ollama Cloud tariff
 * (the public rate card), so only the literal "off" turns it off. Legacy
 * configs saying "reference" (the old opt-in) keep pricing on.
 */
export const pricingKnob = (value: unknown): "off" | "on" =>
  value === "off" ? "off" : "on";

/**
 * Pricing is opt-out and the knob lives on the SERVER plugin entry, but /model
 * runs in the TUI entry — scan opencode's config plugin list too. Any entry of
 * this package saying `pricing: "off"` turns the rate row off; legacy
 * `reference` values keep it on. Default on.
 */
export function pricingActive(
  config: unknown,
  ownOptions?: { pricing?: unknown },
): boolean {
  if (pricingKnob(ownOptions?.pricing) === "off") return false;
  const entries: unknown = (config as { plugin?: unknown } | null | undefined)
    ?.plugin;
  if (!Array.isArray(entries)) return true;
  return !entries.some((entry) => {
    const [name, options] = Array.isArray(entry) ? entry : [entry, undefined];
    return (
      typeof name === "string" &&
      name.startsWith("@srnoob2570/opencode-ollama-cloud") &&
      pricingKnob((options as { pricing?: unknown } | undefined)?.pricing) ===
        "off"
    );
  });
}

/**
 * The /model card reads the catalog through the same doors as the server
 * entry: a user-configured `catalogUrl` (set on either entry) must replace
 * the default mirrors — and the official-rate table runs rateless beside it
 * (loadPricing's custom-catalog contract). Without this scan the card would
 * render OUR rates for a third-party catalog's model ids.
 */
export function configuredCatalogUrl(
  config: unknown,
  ownOptions?: { catalogUrl?: unknown },
): string | undefined {
  if (typeof ownOptions?.catalogUrl === "string") return ownOptions.catalogUrl;
  const entries: unknown = (config as { plugin?: unknown } | null | undefined)
    ?.plugin;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const [name, options] = Array.isArray(entry) ? entry : [entry, undefined];
    const url = (options as { catalogUrl?: unknown } | undefined)?.catalogUrl;
    if (
      typeof name === "string" &&
      name.startsWith("@srnoob2570/opencode-ollama-cloud") &&
      typeof url === "string"
    )
      return url;
  }
  return undefined;
}
