import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { familyOf } from "./resolve-catalog.ts";
import {
  OLLAMA_PRICING_URL,
  buildPricingTable,
  diffPricingTable,
  parsePricingPage,
} from "./update-pricing.ts";
import { catalogModel } from "./test-fixtures.ts";

const fixture = () =>
  readFileSync(
    new URL("./fixtures/ollama-pricing-page.html", import.meta.url),
    "utf8",
  );

// The rate card as captured 2026-09-01 (fixture). Anchor assertions on real
// values: the parser must reproduce the page, not a guess of it.
describe("parsePricingPage (anclado al id de sección, no a clases)", () => {
  test("parsea las 19 filas de la rate card con input / cached / output", () => {
    const rates = parsePricingPage(fixture());
    expect(rates.size).toBe(19);
    expect(rates.get("deepseek-v4-flash")).toEqual({
      input: 0.44,
      cachedInput: 0.014,
      output: 1.32,
    });
    expect(rates.get("kimi-k3")).toEqual({
      input: 3,
      cachedInput: 0.3,
      output: 15,
    });
    expect(rates.get("qwen3.5:397b")).toEqual({
      input: 0.6,
      cachedInput: 0.6,
      output: 3.6,
    });
  });

  test("mapea por TEXTO del enlace, no por href (tres ids difieren)", () => {
    const rates = parsePricingPage(fixture());
    // href="/library/qwen3.5" but the row text is qwen3.5:397b
    expect(rates.has("qwen3.5:397b")).toBe(true);
    expect(rates.has("gpt-oss:120b")).toBe(true);
    expect(rates.has("gpt-oss:20b")).toBe(true);
  });

  test("los montos con coma FUERA de la sección nunca contaminan", () => {
    const rates = parsePricingPage(fixture());
    for (const rate of rates.values()) {
      expect(Number.isFinite(rate.input)).toBe(true);
      expect(rate.input).toBeLessThan(100);
      expect(rate.output).toBeLessThan(100);
    }
  });

  test("falla ruidosamente sin la sección (estructura cambiada)", () => {
    expect(() =>
      parsePricingPage("<html><body><p>Plans only</p></body></html>"),
    ).toThrow(/model-pricing/);
  });

  test("falla ruidosamente con filas malformadas (montos ≠ 3)", () => {
    // drop the cached-input amount from the first row → 2 amounts, not 3
    const broken = fixture().replace(
      '<td class="border-l border-t border-neutral-200 px-4 py-3 text-right">$0.014</td>',
      '<td class="border-l border-t border-neutral-200 px-4 py-3 text-right">—</td>',
    );
    expect(() => parsePricingPage(broken)).toThrow(/exactly 3/);
  });

  test("falla ruidosamente con ids duplicados", () => {
    const duplicated = fixture().replace(
      '<a href="/library/gemma4" class="hover:underline">gemma4</a>',
      '<a href="/library/glm-5.3" class="hover:underline">glm-5.3</a>',
    );
    expect(() => parsePricingPage(duplicated)).toThrow(/duplicate/);
  });

  test("falla ruidosamente con la sección sin <tbody>", () => {
    const noBody = fixture().replace("<tbody>", "");
    expect(() => parsePricingPage(noBody)).toThrow(/tbody/);
  });
});

describe("buildPricingTable (mapeo por familia al id de catálogo)", () => {
  const CATALOG_IDS = [
    "deepseek-v4-flash:0731",
    "deepseek-v4-pro:0813",
    "gemma4:31b",
    "glm-5.3",
    "glm-5.3-flash",
    "gpt-oss:120b",
    "gpt-oss:20b",
    "kimi-k3",
    "qwen3.5:397b",
  ];
  const rates = () => {
    const raw = parsePricingPage(fixture());
    // Only the names the trimmed catalog knows
    const keep = new Set([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemma4",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-oss:120b",
      "gpt-oss:20b",
      "kimi-k3",
      "qwen3.5:397b",
    ]);
    return new Map([...raw].filter(([name]) => keep.has(name)));
  };

  test("ids exactos matchean verbatim; los 5 con tag resuelven por familia", () => {
    const { table, report } = buildPricingTable(
      rates(),
      CATALOG_IDS,
      "2026-09-02",
    );
    expect(report).toEqual([]);
    expect(table["gpt-oss:120b"].input).toBe(0.15);
    expect(table["gpt-oss:20b"].input).toBe(0.07);
    expect(table["deepseek-v4-flash:0731"].input).toBe(0.44);
    expect(table["gemma4:31b"].cachedInput).toBe(0.05);
    expect(table["qwen3.5:397b"].output).toBe(3.6);
    // canonical meta on every entry
    expect(table["kimi-k3"]).toEqual({
      input: 3,
      output: 15,
      cachedInput: 0.3,
      unit: "per-1M",
      source: OLLAMA_PRICING_URL,
      asOf: "2026-09-02",
    });
  });

  test("familia ambigua (dos tags, nombre sin tag) → error, nunca adivina", () => {
    expect(() =>
      buildPricingTable(
        new Map([["gpt-oss", { input: 1, cachedInput: 1, output: 1 }]]),
        CATALOG_IDS,
        "2026-09-01",
      ),
    ).toThrow(/ambiguous|ambiguo|gpt-oss/);
  });

  test("modelo en la página y no en el catálogo → reportado, tabla parcial igual se construye", () => {
    const rates = new Map([
      ["kimi-k3", { input: 3, cachedInput: 0.3, output: 15 }],
      ["kimi-k99", { input: 1, cachedInput: 1, output: 1 }],
    ]);
    const { table, report } = buildPricingTable(
      rates,
      ["kimi-k3"],
      "2026-09-02",
    );
    expect(Object.keys(table)).toEqual(["kimi-k3"]);
    expect(report.some((line) => line.includes("kimi-k99"))).toBe(true);
  });

  test("modelo del catálogo sin tarifa → reportado", () => {
    const { report } = buildPricingTable(
      new Map([["kimi-k3", { input: 3, cachedInput: 0.3, output: 15 }]]),
      ["kimi-k3", "glm-5.3"],
      "2026-09-01",
    );
    expect(report.some((line) => line.includes("glm-5.3"))).toBe(true);
  });

  test("la familia es el id sin tag (CONTEXT.md: family, nunca 'base')", () => {
    expect(familyOf("deepseek-v4-flash:0731")).toBe("deepseek-v4-flash");
  });
});

describe("diffPricingTable (diff rate-por-rate antes de escribir)", () => {
  const rate = (input: number, cachedInput = 0.3, output = 15) => ({
    input,
    output,
    cachedInput,
    unit: "per-1M" as const,
    source: OLLAMA_PRICING_URL,
    asOf: "2026-09-01",
  });

  test("sin cambios → vacío", () => {
    const table = { "kimi-k3": rate(3) };
    expect(diffPricingTable(table, table)).toEqual([]);
  });

  test("tarifa cambiada → línea con antes→después", () => {
    const diff = diffPricingTable(
      { "kimi-k3": rate(3) },
      { "kimi-k3": rate(3.5) },
    );
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain("kimi-k3");
    expect(diff[0]).toContain("3");
    expect(diff[0]).toContain("3.5");
  });

  test("modelo nuevo y modelo retirado se reportan", () => {
    const diff = diffPricingTable(
      { "kimi-k2.6": rate(1), "kimi-k3": rate(3) },
      { "kimi-k3": rate(3), "kimi-k99": rate(1) },
    );
    expect(
      diff.some(
        (line) => line.includes("kimi-k2.6") && line.includes("retired"),
      ),
    ).toBe(true);
    expect(
      diff.some((line) => line.includes("kimi-k99") && line.includes("new")),
    ).toBe(true);
  });

  test("primera corrida (sin tabla previa) → todo es nuevo", () => {
    const diff = diffPricingTable(null, { "kimi-k3": rate(3) });
    expect(diff).toHaveLength(1);
  });
});
