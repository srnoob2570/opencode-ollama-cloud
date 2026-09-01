// Manual pricing workflow: fetch the OFFICIAL Ollama Cloud rate card
// (https://ollama.com/pricing), parse its model-pricing table, map the rate
// card's names onto catalog ids, and regenerate catalog/pricing.json with a
// visible rate-by-rate diff. NEVER run by CI: the owner decides when to
// refresh and reviews the diff before committing (wayfinder map "pricing
// opt-out y tarifa oficial de Ollama", decisions 6/8/10).
//
// Parse policy (research/parse-pricing-page.md): the table lives in the
// initial HTML — anchor on the section's id, NEVER on styling classes; map
// by the row's link TEXT, not its href (three ids differ); fail loudly on
// any structure surprise. No silent partial updates, ever.
import { rename } from "node:fs/promises";
import {
  PROVIDER_ID,
  type Catalog,
  type PricingTable,
  pricingCoverageProblems,
} from "../plugin/catalog.ts";
import { familyOf } from "./resolve-catalog.ts";

export const OLLAMA_PRICING_URL = "https://ollama.com/pricing";

const PRICING_PATH = new URL("../catalog/pricing.json", import.meta.url)
  .pathname;
const CATALOG_PATH = new URL("../catalog/catalog.json", import.meta.url)
  .pathname;
const SECTION_ID = "model-pricing";

export interface ParsedRate {
  input: number;
  cachedInput: number;
  output: number;
}

// Fetch fail-loud, mirroring update-catalog.ts: a broken fetch must abort the
// manual run, not write a stale table as if it were fresh.
async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": `${PROVIDER_ID}-pricing-updater` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// Anchor on the section id (stable), parse rows from <tbody> on. Per row: the
// model name is the link TEXT (hrefs diverge on three rows) and exactly three
// $ amounts follow — input, cached input, output, the rate card's column
// order. Anything else is a structural change and must fail loudly: a
// silently misparsed row would publish wrong prices as fresh.
export function parsePricingPage(html: string): Map<string, ParsedRate> {
  const anchor = html.indexOf(`id="${SECTION_ID}"`);
  if (anchor === -1)
    throw new Error(
      `pricing page: <section id="${SECTION_ID}"> not found — Ollama's page structure changed?`,
    );
  const rest = html.slice(anchor);
  const end = rest.indexOf("</section>");
  const section = end === -1 ? rest : rest.slice(0, end);
  const tbody = section.indexOf("<tbody>");
  if (tbody === -1)
    throw new Error(
      `pricing page: <tbody> not found inside the ${SECTION_ID} section`,
    );

  const rates = new Map<string, ParsedRate>();
  for (const row of section.slice(tbody).split("<tr>")) {
    // Rows before the first model link (the gap between <tbody> and <tr>,
    // the header row) carry no <a> — skipped, not an error.
    const nameMatch = row.match(/<a[^>]*>([^<]+)<\/a>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const amounts = [...row.matchAll(/\$\s*([0-9][0-9.]*)/g)].map((m) =>
      Number(m[1]),
    );
    if (
      amounts.length !== 3 ||
      amounts.some((n) => !Number.isFinite(n) || n <= 0)
    )
      throw new Error(
        `pricing page: row for "${name}" does not carry exactly 3 positive amounts (input, cached input, output) — Ollama's table changed?`,
      );
    if (rates.has(name))
      throw new Error(`pricing page: duplicate row for "${name}"`);
    rates.set(name, {
      input: amounts[0],
      cachedInput: amounts[1],
      output: amounts[2],
    });
  }
  if (rates.size === 0)
    throw new Error(`pricing page: no model rows found in ${SECTION_ID}`);
  return rates;
}

// Rate-card name → catalog id. Exact id first; otherwise the family (the id
// without its serving tag — CONTEXT.md: family is the term) must match
// EXACTLY ONE catalog id. A family spanning several tags is ambiguous and
// fails loudly rather than guessing.
export function resolveRateId(
  rateName: string,
  catalogIds: string[],
): string | undefined {
  if (catalogIds.includes(rateName)) return rateName;
  const family = familyOf(rateName);
  const matches = catalogIds.filter((id) => familyOf(id) === family);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new Error(
      `pricing page: rate "${rateName}" is ambiguous — catalog families ${family}: ${matches.join(", ")}`,
    );
  return undefined;
}

// Build the canonical table from parsed rates + catalog ids. Rates the
// catalog doesn't know and catalog models without a rate are REPORTED (the
// shared coverage rule — the same function CI's validator runs), never
// silently dropped: the caller (main) aborts on any report and nothing is
// written. Keys sorted alphabetically so regenerations produce stable diffs.
export function buildPricingTable(
  rates: Map<string, ParsedRate>,
  catalogIds: string[],
  today: string,
): { table: PricingTable; report: string[] } {
  const table: PricingTable = {};

  for (const [name, rate] of rates) {
    const id = resolveRateId(name, catalogIds);
    if (id === undefined) continue;
    table[id] = {
      input: rate.input,
      output: rate.output,
      cachedInput: rate.cachedInput,
      unit: "per-1M",
      source: OLLAMA_PRICING_URL,
      asOf: today,
    };
  }

  // Rate names that resolved to nothing never make it into the table, so the
  // shared coverage check cannot see them — report them from the raw names.
  const unresolved = [...rates.keys()].filter(
    (name) => resolveRateId(name, catalogIds) === undefined,
  );
  const { missingRates } = pricingCoverageProblems(table, catalogIds);
  return {
    table: sorted(table),
    report: [
      ...unresolved.map(
        (name) =>
          `rate card lists "${name}", which is not in the catalog (typo or retired model? run update-catalog, then update-pricing)`,
      ),
      ...missingRates,
    ],
  };
}

const sorted = (table: PricingTable): PricingTable =>
  Object.fromEntries(
    Object.entries(table).sort(([a], [b]) => a.localeCompare(b)),
  );

// Rate-by-rate diff for the owner to review before committing. Values are
// compared per field (input, cachedInput, output); asOf changes alone are
// NOT a diff — refreshing the stamp without a price change is noise. The
// $schema pointer is metadata, never a diff line. Relative to catalog/ so
// the pointer resolves both in the repo and in the npm package.
const SCHEMA_POINTER = "../pricing.schema.json";

export function diffPricingTable(
  before: PricingTable | null,
  after: PricingTable,
): string[] {
  const lines: string[] = [];
  for (const [id, rate] of Object.entries(after)) {
    if (id === "$schema") continue;
    const prev = before?.[id];
    if (!prev) {
      lines.push(
        `+ ${id}: new (input ${rate.input} · cached ${rate.cachedInput} · output ${rate.output})`,
      );
      continue;
    }
    const changes: string[] = [];
    if (prev.input !== rate.input)
      changes.push(`input ${prev.input}→${rate.input}`);
    if (prev.cachedInput !== rate.cachedInput)
      changes.push(`cachedInput ${prev.cachedInput}→${rate.cachedInput}`);
    if (prev.output !== rate.output)
      changes.push(`output ${prev.output}→${rate.output}`);
    if (changes.length > 0) lines.push(`~ ${id}: ${changes.join(", ")}`);
  }
  if (before)
    for (const id of Object.keys(before))
      if (!(id in after) && id !== "$schema")
        lines.push(`- ${id}: retired from the rate card`);
  return lines;
}

async function loadCurrentTable(): Promise<PricingTable | null> {
  try {
    return (await Bun.file(PRICING_PATH).json()) as PricingTable;
  } catch {
    return null;
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const html = await fetchPage(OLLAMA_PRICING_URL);
  const catalog = (await Bun.file(CATALOG_PATH).json()) as {
    models: { id: string }[];
  };
  const catalogIds = catalog.models.map((m) => m.id);

  const rates = parsePricingPage(html);
  const { table, report } = buildPricingTable(rates, catalogIds, today);
  // Abort with a report, write NOTHING: a partial pricing update that
  // silently skips models would publish $0 as if it were the official rate.
  if (report.length > 0) {
    console.error(
      `rate card and catalog disagree (${report.length}) — aborting without writing:`,
    );
    for (const line of report) console.error(`  ✗ ${line}`);
    process.exit(1);
  }

  const current = await loadCurrentTable();
  const diff = diffPricingTable(current, table);
  // The written content is the diff's ground truth: identical bytes → nothing
  // to do (also covers metadata-only drift, e.g. a missing $schema pointer).
  const nextContent =
    JSON.stringify({ $schema: SCHEMA_POINTER, ...table }, null, 2) + "\n";
  const currentRaw = await Bun.file(PRICING_PATH)
    .text()
    .catch(() => null);
  if (nextContent === currentRaw) {
    console.log(
      `pricing unchanged (${Object.keys(table).length} rates, asOf ${today})`,
    );
    return;
  }
  if (diff.length > 0) {
    console.log(`pricing changes (${diff.length}):`);
    for (const line of diff) console.log(`  ${line}`);
  } else {
    console.log("no rate changes; rewriting metadata");
  }

  // Atomic: a torn write must never leave a half-table for the plugin to join.
  await Bun.write(PRICING_PATH + ".tmp", nextContent);
  await rename(PRICING_PATH + ".tmp", PRICING_PATH);
  console.log(
    `catalog/pricing.json updated: ${Object.keys(table).length} rates, asOf ${today}`,
  );
}

// Guarded so tests import the pure core without triggering a live fetch.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
