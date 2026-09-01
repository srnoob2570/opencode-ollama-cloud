import { describe, expect, test } from "bun:test";
import {
  isPricingTable,
  pricingCoverageProblems,
  type PricingTable,
} from "../plugin/catalog.ts";
import { pricingRate } from "./test-fixtures.ts";

// The SHIPPED files are a contract too (code-review finding): the deleted
// pricing resolver used to carry an end-to-end check of the real overrides
// file on every `bun test`. Its replacement reads the real table against the
// real catalog, so a hand-edited pricing.json with a typo'd key or a bad rate
// fails locally — never only in CI. (bun test does not run in the scheduled
// update workflow, so this gate cannot deadlock it; CI's validate handles
// that path with warnings.)
const REAL_TABLE_PATH = new URL("../catalog/pricing.json", import.meta.url);
const REAL_CATALOG_PATH = new URL("../catalog/catalog.json", import.meta.url);

describe("catalog/pricing.json publicado (end-to-end)", () => {
  const table = () => Bun.file(REAL_TABLE_PATH).json();

  test("la tabla publicada pasa el contrato estructural", async () => {
    expect(isPricingTable(await table())).toBe(true);
  });

  test("cobertura completa contra el catálogo publicado, en ambas direcciones", async () => {
    const [tableData, catalog] = await Promise.all([
      table(),
      Bun.file(REAL_CATALOG_PATH).json(),
    ]);
    const catalogIds = (catalog as { models: { id: string }[] }).models.map(
      (m) => m.id,
    );
    const { orphanRates, missingRates } = pricingCoverageProblems(
      tableData as Parameters<typeof pricingCoverageProblems>[0],
      catalogIds,
    );
    expect(orphanRates).toEqual([]);
    expect(missingRates).toEqual([]);
  });

  test("las tarifas de la tabla publicada traen la fuente canónica", async () => {
    const tableData = (await table()) as PricingTable;
    for (const [id, rate] of Object.entries(tableData)) {
      if (id === "$schema") continue;
      expect(rate.unit, id).toBe("per-1M");
      expect(rate.source, id).toBe("https://ollama.com/pricing");
    }
  });
});

// Guardrails for the pure cross-check with typed fixtures (the real-file
// tests above cover the shipped state; these cover the failure modes).
describe("cobertura con fixtures (modos de falla)", () => {
  test("modelo de catálogo sin tarifa → problema nombrado", () => {
    const { missingRates } = pricingCoverageProblems(
      { "kimi-k3": pricingRate() },
      ["kimi-k3", "glm-5.3"],
    );
    expect(missingRates).toHaveLength(1);
    expect(missingRates[0]).toContain("glm-5.3");
  });

  test("tabla malformada no cruza la cobertura (el schema/contrato la atrapan antes)", () => {
    // pricingCoverageProblems trusts its input: the structural gate
    // (isPricingTable, schema) runs first in every caller. This documents
    // the division of labor rather than re-testing it.
    expect(isPricingTable({ broken: { input: 0, output: 15 } })).toBe(false);
  });
});
