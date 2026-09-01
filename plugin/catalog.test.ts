import { describe, expect, test } from "bun:test";
import { catalogModel, catalogWith } from "../scripts/test-fixtures.ts";
import { isCatalog } from "./catalog.ts";

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

// Optional pricing/provenance blocks: catalogs without them (old versions)
// stay valid; catalogs with them must carry the right shape so garbage
// prices never reach the plugin's cost mapping.
describe("isCatalog optional pricing blocks", () => {
  const validModel = catalogModel("glm-5.3-flash", {
    name: "GLM 5.3 Flash",
    created: 1787929200,
    family: "glm",
    capabilities: { tools: true, thinking: true, vision: false },
    context: 1024 * 1024,
    maxOutput: 131072,
  });

  test("absent blocks pass (old catalogs load unchanged)", () => {
    expect(isCatalog(catalogWith([validModel]))).toBe(true);
  });

  test("well-shaped pricing passes", () => {
    const withPricing = {
      ...validModel,
      pricing: {
        input: 0.075,
        output: 0.25,
        unit: "per-1M",
        provider: "zai",
        source: "https://x",
        asOf: "2026-08-30",
      },
    };
    expect(isCatalog(catalogWith([withPricing]))).toBe(true);
  });

  test("garbage pricing is rejected (wrong unit, non-numeric costs)", () => {
    const badUnit = {
      ...validModel,
      pricing: { ...validModel, input: 1, output: 1, unit: "per-token" },
    };
    const badNumbers = {
      ...validModel,
      pricing: {
        input: "0.075",
        output: 0.25,
        unit: "per-1M",
        provider: "zai",
        source: "https://x",
        asOf: "2026-08-30",
      },
    };
    expect(isCatalog(catalogWith([badUnit]))).toBe(false);
    expect(isCatalog(catalogWith([badNumbers]))).toBe(false);
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

describe("isCatalog pricing compat (code review fixes)", () => {
  const validModel = catalogModel("kimi-k3", {
    name: "Kimi K3",
    context: 1024 * 1024,
    maxOutput: 131072,
  });

  test("a foreign catalog with models.dev-shaped pricing ({input, output}) still loads", () => {
    expect(
      isCatalog(
        catalogWith([{ ...validModel, pricing: { input: 0.2, output: 0.7 } }]),
      ),
    ).toBe(true);
  });

  test("negative, NaN and Infinity prices are rejected", () => {
    const bad = [
      { input: -5, output: 2 },
      { input: Number.NaN, output: 2 },
      { input: 1e999, output: 2 },
    ];
    for (const pricing of bad)
      expect(isCatalog(catalogWith([{ ...validModel, pricing }]))).toBe(false);
  });
});
