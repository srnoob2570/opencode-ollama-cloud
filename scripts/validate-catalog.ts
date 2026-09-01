import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  PROVIDER_ID,
  isCatalog,
  isPricingTable,
  pricingCoverageProblems,
  type PricingTable,
} from "../plugin/catalog.ts";

// CI gate run after `update` and before any commit: refuse to publish a catalog
// that fails the structural contract (isCatalog mirrors catalog.schema.json,
// including context >= 1) or sanity checks. Without this, a scrape regression
// (e.g. ollama.com markup drift) would be auto-committed and pushed to the CDN.
//
// Dual-contract check (SIMPL-015): isCatalog is the runtime gate; the JSON
// schema is the published contract. CI validates the catalog against BOTH so
// the hand-mirrored pair cannot drift apart silently.
//
// The pricing table (catalog/pricing.json) gets the same treatment for its
// SCHEMA and structural contract — a malformed table must never ship. Its
// coverage against the catalog is a WARNING, not a gate: the table is
// manual-workflow output, so when Ollama adds or retires a model the
// scheduled update publishes the catalog first and CI must not deadlock
// waiting for the owner to run update-pricing. The plugin degrades to $0 for
// unrated models; the warning points at the fix.
const CATALOG_PATH = new URL("../catalog/catalog.json", import.meta.url)
  .pathname;
const SCHEMA_PATH = new URL("../catalog.schema.json", import.meta.url).pathname;
const PRICING_PATH = new URL("../catalog/pricing.json", import.meta.url)
  .pathname;
const PRICING_SCHEMA_PATH = new URL("../pricing.schema.json", import.meta.url)
  .pathname;

// Guarded like the other entrypoints (update-catalog.ts uses import.meta.main):
// importing this module never runs the validation.
if (import.meta.main) {
  const data: unknown = await Bun.file(CATALOG_PATH).json();
  const schema: unknown = await Bun.file(SCHEMA_PATH).json();

  const problems: string[] = [];
  // Coverage drift (a model the table doesn't know, or a rate the catalog
  // dropped) is reported but never fails the run: blocking publish would
  // deadlock the scheduled update until the owner runs update-pricing.
  const coverageWarnings: string[] = [];
  let modelCount = 0;
  let rateCount = 0;

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  if (!ajv.validate(schema as object, data)) {
    problems.push(`fails catalog.schema.json — ${ajv.errorsText(ajv.errors)}`);
  }

  if (!isCatalog(data)) {
    problems.push(
      "fails the structural contract in plugin/catalog.ts (isCatalog) — check for context < 1, missing releaseDate/family, or wrong types",
    );
  } else {
    modelCount = data.models.length;
    if (data.provider.id !== PROVIDER_ID) {
      problems.push(
        `provider.id is "${data.provider.id}", expected "${PROVIDER_ID}"`,
      );
    }
    if (data.models.length === 0) problems.push("contains 0 models");
    // generatedAt's date-time format is covered by the schema check above
    // (format: "date-time"); only checks the schema doesn't express live here.
    if (!/^[0-9a-f]{64}$/.test(data.modelsHash))
      problems.push("modelsHash is not a sha256 hex string");
  }

  // The pricing table is manual-workflow output and ships with the catalog:
  // its schema and structural contract are hard gates; coverage against the
  // catalog is advisory (the manual workflow catches up on its own schedule).
  let pricingData: unknown;
  try {
    pricingData = await Bun.file(PRICING_PATH).json();
  } catch {
    problems.push("catalog/pricing.json is missing or unparsable");
  }
  if (pricingData !== undefined) {
    const pricingSchema: unknown = await Bun.file(PRICING_SCHEMA_PATH).json();
    if (!ajv.validate(pricingSchema as object, pricingData)) {
      problems.push(
        `fails pricing.schema.json — ${ajv.errorsText(ajv.errors)}`,
      );
    }
    if (!isPricingTable(pricingData)) {
      problems.push(
        "fails the structural contract in plugin/catalog.ts (isPricingTable) — check for zero/negative/non-numeric rates",
      );
    } else if (isCatalog(data)) {
      const { orphanRates, missingRates } = pricingCoverageProblems(
        pricingData as PricingTable,
        data.models.map((m) => m.id),
      );
      coverageWarnings.push(...orphanRates, ...missingRates);
      rateCount = Object.keys(pricingData as PricingTable).filter(
        (k) => k !== "$schema",
      ).length;
    }
  }

  for (const w of coverageWarnings) console.warn(`warning: ${w}`);

  if (problems.length > 0) {
    console.error("catalog is invalid:");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }

  console.log(
    `catalog/catalog.json valid: ${modelCount} models; catalog/pricing.json valid: ${rateCount} rates`,
  );
}
