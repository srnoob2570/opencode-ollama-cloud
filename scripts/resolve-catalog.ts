import type { CatalogModel, ModelPricing } from "../plugin/catalog.ts"

// Reference pricing resolver — the single curation seam of ticket 01
// (wayfinder: "precio de referencia y fuentes endurecidas"). Pure: the caller
// passes already-fetched data; no network, no filesystem.
//
// Priority: overrides > models.dev first-party rule. models.dev costs are USD
// per 1M tokens, matching opencode's CostV2 usage directly.

export const MODELS_DEV_URL = "https://models.dev/api.json"

export interface OverrideEntry {
  input: number
  output: number
  provider?: string
  source?: string
  asOf?: string
  note?: string
}

export type PricingOverrides = Record<string, OverrideEntry>

export interface ResolverInput {
  seed: Record<string, any>
  overrides: PricingOverrides
  today: string
}

export interface ResolverResult {
  models: CatalogModel[]
  warnings: string[]
}

// First-party provider per catalog base (wayfinder ticket "tabla de precio de
// referencia por modelo", 2026-08-30). Bases only: ids may carry tags.
const FIRST_PARTY_PROVIDER: Record<string, string> = {
  glm: "zai",
  kimi: "moonshotai",
  "deepseek-v4-pro": "deepseek",
  "deepseek-v4-flash": "deepseek",
  "qwen3.5": "alibaba",
  "nemotron-3-ultra": "nvidia",
  "nemotron-3-super": "nvidia",
  minimax: "minimax",
  "mistral-large-3": "mistral",
}

// Upstream model keys that differ from our catalog ids (same ticket: the
// research documented these transforms instead of guessing them). Some
// providers namespace their keys ("nvidia/<model>").
const UPSTREAM_ALIASES: Record<string, string> = {
  "qwen3.5:397b": "qwen3.5-397b-a17b",
  "nemotron-3-ultra": "nvidia/nemotron-3-ultra-550b-a55b",
  "nemotron-3-super": "nvidia/nemotron-3-super-120b-a12b",
  "mistral-large-3:675b": "mistral-large-2512",
  "minimax-m3": "MiniMax-M3",
  "minimax-m2.7": "MiniMax-M2.7",
}

const realCost = (cost: any): { input: number; output: number } | undefined =>
  typeof cost?.input === "number" &&
  typeof cost?.output === "number" &&
  cost.input > 0 &&
  cost.output > 0
    ? { input: cost.input, output: cost.output }
    : undefined

const keysFor = (id: string): string[] => {
  const base = id.split(":")[0]
  return [...new Set([UPSTREAM_ALIASES[id], id, base].filter(
    (k): k is string => typeof k === "string",
  ))]
}

// models.dev free plans publish 0/0; only real tarifs count as price data.
function pickCost(
  models: Record<string, any>,
  id: string,
): { input: number; output: number; key: string } | undefined {
  for (const key of keysFor(id)) {
    const cost = realCost(models[key]?.cost)
    if (cost) return { ...cost, key }
  }
  return undefined
}

function firstPartyProviderFor(base: string): string | undefined {
  if (FIRST_PARTY_PROVIDER[base]) return FIRST_PARTY_PROVIDER[base]
  // Bases carry suffixes (glm-5.3-flash, kimi-k2.7-code, minimax-m3): the
  // prefix form resolves them — but "nemotron-3-nano" must NOT inherit
  // nemotron-3-ultra's nvidia mapping, so only explicit entries prefix-match.
  for (const [key, provider] of Object.entries(FIRST_PARTY_PROVIDER)) {
    if (base.startsWith(`${key}-`)) return provider
  }
  return undefined
}

function firstPartyCost(
  seed: Record<string, any>,
  id: string,
): { provider: string; input: number; output: number } | undefined {
  const base = id.split(":")[0]
  const provider = firstPartyProviderFor(base)
  if (!provider) return undefined
  const pick = pickCost(seed[provider]?.models ?? {}, id)
  return pick ? { provider, ...pick } : undefined
}

// Marketplace mode: most frequent real priced (input, output) across any
// provider hosting this model. Ties resolve deterministically — most
// frequent, then cheapest input, then cheapest output — independent of the
// seed's provider key order. Marked `provider: "derived"` — a guess, not a
// first-party tariff.
function marketCost(
  seed: Record<string, any>,
  id: string,
): { input: number; output: number } | undefined {
  const counts = new Map<string, { cost: { input: number; output: number }; n: number }>()
  for (const provider of Object.values<any>(seed)) {
    const models = provider?.models ?? {}
    const pick = pickCost(models, id)
    if (!pick) continue
    const k = `${pick.input}:${pick.output}`
    const prev = counts.get(k)
    if (prev) prev.n += 1
    else counts.set(k, { cost: { input: pick.input, output: pick.output }, n: 1 })
  }
  let best: { cost: { input: number; output: number }; n: number } | undefined
  for (const entry of counts.values()) {
    if (
      !best ||
      entry.n > best.n ||
      (entry.n === best.n &&
        (entry.cost.input < best.cost.input ||
          (entry.cost.input === best.cost.input && entry.cost.output < best.cost.output)))
    )
      best = entry
  }
  return best?.cost
}

// A malformed override must never poison the catalog: isCatalog rejects the
// whole catalog when a pricing block carries a non-string provider/source.
// Malformed entries are ignored (with a warning) instead of trusted verbatim.
function isOverride(v: unknown): v is OverrideEntry {
  if (typeof v !== "object" || v === null) return false
  const o = v as OverrideEntry
  return (
    typeof o.input === "number" &&
    Number.isFinite(o.input) &&
    o.input > 0 &&
    typeof o.output === "number" &&
    Number.isFinite(o.output) &&
    o.output > 0 &&
    (o.provider === undefined || typeof o.provider === "string") &&
    (o.source === undefined || typeof o.source === "string") &&
    (o.asOf === undefined || typeof o.asOf === "string") &&
    (o.note === undefined || typeof o.note === "string")
  )
}

export function resolveCatalog(
  models: CatalogModel[],
  input: ResolverInput,
): ResolverResult {
  const { seed, overrides, today } = input
  const warnings: string[] = []
  const out: CatalogModel[] = []
  const consumed = new Set<string>()

  for (const m of models) {
    const rawOverride = input.overrides[m.id]
    const ov = isOverride(rawOverride) ? (rawOverride as OverrideEntry) : undefined
    if (rawOverride !== undefined && !ov)
      warnings.push(`${m.id}: override entry is malformed and was ignored`)
    const seedPick = firstPartyCost(seed, m.id)
    let pricing: ModelPricing | undefined
    let sources: Record<string, string> | undefined
    let conflicts: Record<string, Record<string, unknown>> | undefined

    if (ov) {
      consumed.add(m.id)
      // asOf records when the value was TAKEN, not when this run regenerated:
      // a hand-transcribed price must not silently refresh its own freshness
      // stamp on every weekly rescan.
      pricing = {
        input: ov.input,
        output: ov.output,
        unit: "per-1M",
        provider: ov.provider ?? "derived",
        source: ov.source ?? MODELS_DEV_URL,
        asOf: ov.asOf ?? today,
        ...(ov.note ? { note: ov.note } : {}),
      }
      sources = { pricing: "override" }
      if (seedPick && (seedPick.input !== ov.input || seedPick.output !== ov.output)) {
        conflicts = {
          pricing: {
            "models.dev": { input: seedPick.input, output: seedPick.output },
            resolver: "override-wins",
          },
        }
      }
    } else if (seedPick) {
      pricing = {
        input: seedPick.input,
        output: seedPick.output,
        unit: "per-1M",
        provider: seedPick.provider,
        source: MODELS_DEV_URL,
        asOf: today,
      }
      sources = { pricing: "models.dev" }
    } else {
      const mode = marketCost(seed, m.id)
      if (mode) {
        pricing = {
          ...mode,
          unit: "per-1M",
          provider: "derived",
          source: MODELS_DEV_URL,
          asOf: today,
          note: "marketplace mode — consider adding an override",
        }
        sources = { pricing: "models.dev" }
        warnings.push(`${m.id}: using marketplace mode price — consider adding an override`)
      } else {
        warnings.push(`${m.id}: no reference price available (no override, no first-party entry)`)
      }
    }

    out.push({
      ...m,
      ...(pricing ? { pricing } : {}),
      ...(sources ? { sources } : {}),
      ...(conflicts ? { conflicts } : {}),
    })
  }

  // An override nobody consumed is a silent bug otherwise: typically a typo'd
  // key or a model ollama re-tagged — the correction would apply to nothing
  // while every other entry still applies.
  for (const id of Object.keys(overrides)) {
    if (!consumed.has(id))
      warnings.push(
        `override for "${id}" matched no model in the live list — check the key for typos or retirements`,
      )
  }

  return { models: out, warnings }
}