// Pure display helpers for the TUI module (tickets 04/05/07). All formats are
// RATIFIED (wayfinder/prototipo-seccion-estadisticas.mock.md) — this module is
// the string contract; the .tsx module only wires it into opencode's slots.
// Pure by design: testable without opencode, no fs, no time.
import type { SessionSummary, StepMeasurement } from "./stats.ts"

export function formatLiveLine(summary: SessionSummary | null): string {
  if (!summary || summary.steps === 0) return "— tok/s · TTFT — ms · Session average"
  return `${summary.avgTps.toFixed(1)} tok/s · TTFT ${Math.round(summary.avgTtftMs)} ms · Session average`
}

/** Relative timestamp for the /stats dialog ("hace 1m"), stable format. */
export function formatRelativeAge(ts: number, now: number): string {
  const s = Math.max(1, Math.round((now - ts) / 1000))
  if (s < 60) return `hace ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m}m`
  return `hace ${Math.floor(m / 60)}h ${m % 60}m`
}

const tokensLabel = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k t` : `${n} t`)

/** One row of the /stats dialog's últimas respuestas (steps, newest first). */
export function formatStepRow(step: StepMeasurement, now: number): string {
  const tps = step.decodeMs > 0 ? (step.tokensOut / (step.decodeMs / 1000)).toFixed(1) : "—"
  return `${formatRelativeAge(step.ts, now)}   ${tps} tok/s · TTFT ${Math.round(step.ttftMs)} ms · ${tokensLabel(step.tokensOut)} ${step.source === "event" ? "(event)" : ""}`
}

export const EMPTY_SESSION_LINE = "sin respuestas medidas todavía — llega la primera y aparecen"

/** The /stats dialog body (mock §2): summary block + últimas respuestas. */
export function formatStatsDialogBody(
  summary: SessionSummary,
  steps: readonly StepMeasurement[],
  modelID = "—",
  now = Date.now(),
): string {
  if (summary.steps === 0) return `  Sesión · ${modelID}\n\n  ${EMPTY_SESSION_LINE}`
  const head = [
    `  Sesión · ${modelID}`,
    "",
    `  ${summary.avgTps.toFixed(1)} tok/s · TTFT ${Math.round(summary.avgTtftMs)} ms · Session average`,
    `  ${summary.steps} respuestas · ${tokensLabel(summary.tokensOutTotal)} salida`,
  ]
  const rows = steps.slice(0, 10).map((s) => `  ${formatStepRow(s, now)}`)
  return [...head, rows.length ? "" : "", ...rows].filter((line) => line !== undefined).join("\n")
}

export interface ModelCard {
  id: string
  name: string
  family: string
  releaseDate: string
  quantization?: string
  /** Catalog provenance (sources.quantization) — implicit rows must not be
   * labeled "(declarada)": Ollama does not declare them (code-review finding). */
  quantizationSource?: string
  context: number
  maxOutput: number
  capabilities: { tools: boolean; thinking: boolean; vision: boolean }
  pricing?: { input: number; output: number } | null
}

/** The /model ficha (mock §3) — quantization is the protagonist. */
export function formatModelCard(model: ModelCard, pricingOn: boolean): string {
  const implicit = model.quantizationSource?.startsWith("implicit") ?? false
  const quantization = !model.quantization
    ? "— (no disponible)"
    : model.quantization === "unknown"
      ? "desconocida"
      : `${model.quantization} ${implicit ? "(implícita)" : "(declarada)"}`
  const rows = [
    `  Nombre            ${model.name}                ollama-cloud`,
    `  ${model.id} · familia ${model.family} · ${model.releaseDate}`,
    "",
    `  Cuantización      ${quantization}`,
    `  Contexto          ${formatTokens(model.context)} · salida ${formatTokens(model.maxOutput)}`,
    `  Capacidades       ${capabilityList(model.capabilities)}`,
    ...(pricingOn ? [`  Precio ref.       $${model.pricing?.input ?? "—"}/${model.pricing?.output ?? "—"} por 1M`] : []),
    "",
    implicit
      ? `  cuantización implícita según fuentes públicas (HF/library)`
  + ` — no garantiza la`
      : `  cuantización declarada por Ollama — no garantiza la`,
    `  precisión servida`,
  ]
  return rows.join("\n")
}

const formatTokens = (n: number): string => (n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))}M` : `${Math.round(n / 1024)}k`)

const capabilityList = (caps: ModelCard["capabilities"]): string => {
  const list: string[] = []
  if (caps.tools) list.push("tools")
  if (caps.thinking) list.push("thinking")
  if (caps.vision) list.push("vision")
  return list.length ? list.join(" · ") : "—"
}

/**
 * Degradación silenciosa: what the TUI module may touch. Anything missing →
 * the module retires without noise (the provider/catalog must keep working).
 */
export function pickTuiFeatures(api: unknown): { slots: boolean; keymap: boolean } {
  const a = api as { slots?: { register?: unknown }; keymap?: { registerLayer?: unknown } } | null | undefined
  return {
    slots: typeof a?.slots?.register === "function",
    keymap: typeof a?.keymap?.registerLayer === "function",
  }
}

/**
 * Reference pricing is documented on the SERVER plugin entry, but /model runs
 * in the TUI entry — scan opencode's config plugin list too (either entry
 * saying `pricing: "reference"` enables the price row).
 */
export function referencePricingActive(config: unknown, ownOptions?: { pricing?: unknown }): boolean {
  if (ownOptions?.pricing === "reference") return true
  const entries: unknown = (config as { plugin?: unknown } | null | undefined)?.plugin
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => {
    const [name, options] = Array.isArray(entry) ? entry : [entry, undefined]
    return (
      typeof name === "string" &&
      name.startsWith("@srnoob2570/opencode-ollama-cloud") &&
      (options as { pricing?: unknown } | undefined)?.pricing === "reference"
    )
  })
}