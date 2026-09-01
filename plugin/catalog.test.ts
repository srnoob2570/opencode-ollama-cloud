import { describe, expect, test } from "bun:test";
import {
  catalogModel,
  catalogWith,
  pricingRate,
} from "../scripts/test-fixtures.ts";
import {
  isCatalog,
  isPricingTable,
  pricingCoverageProblems,
  type PricingRate,
} from "./catalog.ts";

describe("isCatalog", () => {
  const validModel = catalogModel("gpt-oss:120b", {
    name: "GPT OSS (120b)",
    created: 1754402400,
    capabilities: { tools: true, thinking: true, vision: false },
    context: 131072,
    maxOutput: 131072,
    releaseDate: "2026-08-05",
  });
  const validCatalog = catalogWith([validModel]);

  test("accepts a well-formed catalog", () => {
    expect(isCatalog(validCatalog)).toBe(true);
  });

  test("rejects context 0 (scrape-regression guard)", () => {
    const bad = { ...validCatalog, models: [{ ...validModel, context: 0 }] };
    expect(isCatalog(bad)).toBe(false);
  });

  test("rejects missing releaseDate (consumed as a required string downstream)", () => {
    const noDate: Record<string, unknown> = { ...validModel };
    delete noDate.releaseDate;
    expect(isCatalog({ ...validCatalog, models: [noDate] })).toBe(false);
  });

  test("rejects missing family and non-array reasoningOptions", () => {
    const noFamily: Record<string, unknown> = { ...validModel };
    delete noFamily.family;
    expect(isCatalog({ ...validCatalog, models: [noFamily] })).toBe(false);
    const badReasoning = { ...validModel, reasoningOptions: undefined };
    expect(isCatalog({ ...validCatalog, models: [badReasoning] })).toBe(false);
  });

  test("rejects non-objects and shapeless models", () => {
    expect(isCatalog(null)).toBe(false);
    expect(isCatalog("null")).toBe(false);
    expect(isCatalog({ ...validCatalog, models: [{ id: 42 }] })).toBe(false);
  });
});

// Pricing is NOT part of the catalog contract anymore: the official rate
// card (catalog/pricing.json) is its own contract side (isPricingTable). A
// foreign or old catalog carrying embedded pricing still loads — the extra
// field is ignored, the plugin only joins the table.
describe("isCatalog pricing is not the catalog's business", () => {
  const validModel = catalogModel("glm-5.3-flash", {
    name: "GLM 5.3 Flash",
    created: 1787929200,
    family: "glm",
    capabilities: { tools: true, thinking: true, vision: false },
    context: 1024 * 1024,
    maxOutput: 131072,
  });

  test("old catalogs with embedded pricing still load (extra field ignored)", () => {
    expect(
      isCatalog(
        catalogWith([
          { ...validModel, pricing: { input: 0.075, output: 0.25 } },
        ]),
      ),
    ).toBe(true);
  });

  test("a catalog with garbage embedded pricing still loads (never consulted)", () => {
    expect(
      isCatalog(
        catalogWith([{ ...validModel, pricing: { input: "x", output: -1 } }]),
      ),
    ).toBe(true);
  });
});

// Optional quantization: absent (old catalogs) always loads; a present one is
// shape-only — raw values and "unknown" pass, no enum, so a new Ollama format
// can never break the loader (the updater's policy: CI advises, never fails).
describe("isCatalog optional quantization", () => {
  const validModel = catalogModel("glm-5.3", {
    context: 1024 * 1024,
    maxOutput: 131072,
  });

  test("absent field loads (old catalogs unchanged)", () => {
    expect(isCatalog(catalogWith([validModel]))).toBe(true);
  });

  test("raw values and the unknown literal load", () => {
    for (const value of ["FP8", "MXFP4", "unknown", "Some-New-Format-2049"])
      expect(
        isCatalog(catalogWith([{ ...validModel, quantization: value }])),
      ).toBe(true);
  });

  test("garbage is rejected (empty string, numbers)", () => {
    expect(isCatalog(catalogWith([{ ...validModel, quantization: "" }]))).toBe(
      false,
    );
    expect(
      isCatalog(
        catalogWith([{ ...validModel, quantization: 8 as unknown as string }]),
      ),
    ).toBe(false);
  });
});

// The pricing table (catalog/pricing.json) is its own contract side: the
// plugin joins it by model id, so a malformed entry must never reach the
// cost counter (same policy as isCatalog: loader checks shape, schema is
// the published stricter contract).
describe("isPricingTable", () => {
  test("accepts a well-formed table", () => {
    expect(isPricingTable({ "kimi-k3": pricingRate() })).toBe(true);
  });

  test("accepts the $schema pointer (metadata, not an entry)", () => {
    expect(
      isPricingTable({
        $schema: "./pricing.schema.json",
        "kimi-k3": pricingRate(),
      }),
    ).toBe(true);
  });

  test("rejects non-objects and arrays", () => {
    expect(isPricingTable(null)).toBe(false);
    expect(isPricingTable("table")).toBe(false);
    expect(isPricingTable([pricingRate()])).toBe(false);
  });

  test("rejects zero, negative, NaN and Infinity rates", () => {
    for (const over of [
      { input: 0 },
      { input: -1 },
      { output: Number.NaN },
      { output: 1e999 },
    ]) {
      expect(isPricingTable({ "kimi-k3": pricingRate(over) })).toBe(false);
    }
  });

  test("rejects a wrong unit and non-string meta", () => {
    expect(
      isPricingTable({
        "kimi-k3": pricingRate({
          unit: "per-token",
        } as unknown as Partial<PricingRate>),
      }),
    ).toBe(false);
    expect(
      isPricingTable({
        "kimi-k3": pricingRate({ asOf: 42 } as unknown as Partial<PricingRate>),
      }),
    ).toBe(false);
  });

  test("cachedInput is optional but must be finite and positive (schema parity)", () => {
    const { cachedInput: _drop, ...noCache } = pricingRate();
    expect(isPricingTable({ "kimi-k3": noCache })).toBe(true);
    expect(
      isPricingTable({ "kimi-k3": pricingRate({ cachedInput: -0.01 }) }),
    ).toBe(false);
    expect(isPricingTable({ "kimi-k3": pricingRate({ cachedInput: 0 }) })).toBe(
      false,
    );
  });
});

// The coverage cross-check lives here (next to the contract it enforces) and
// is shared by CI's validator and the manual update-pricing workflow — one
// implementation, so the two can never drift apart (code-review finding).
describe("pricingCoverageProblems (cobertura tabla ↔ catálogo)", () => {
  test("tabla completa y sin huérfanos → vacío", () => {
    const { orphanRates, missingRates } = pricingCoverageProblems(
      { "kimi-k3": pricingRate() },
      ["kimi-k3", "glm-5.3-flash"],
    );
    expect(orphanRates).toEqual([]);
    expect(missingRates).toEqual([
      'catalog model "glm-5.3-flash" has no rate on the pricing page (run bun run update-pricing)',
    ]);
  });

  test("tarifa huérfana y modelo sin tarifa se reportan por separado", () => {
    const { orphanRates, missingRates } = pricingCoverageProblems(
      { "kimi-k99": pricingRate() },
      ["kimi-k3"],
    );
    expect(orphanRates).toHaveLength(1);
    expect(orphanRates[0]).toContain("kimi-k99");
    expect(missingRates).toHaveLength(1);
    expect(missingRates[0]).toContain("kimi-k3");
  });

  test("el puntero $schema nunca es una tarifa huérfana", () => {
    const table = JSON.parse(
      JSON.stringify({
        $schema: "./pricing.schema.json",
        "kimi-k3": pricingRate(),
      }),
    ) as Parameters<typeof pricingCoverageProblems>[0];
    expect(pricingCoverageProblems(table, ["kimi-k3"]).orphanRates).toEqual([]);
  });
});
