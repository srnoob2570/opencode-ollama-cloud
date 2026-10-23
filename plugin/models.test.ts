import { describe, expect, test } from "bun:test";
import type { CatalogModel, PricingRate } from "./catalog.ts";
import { toModelRecord } from "./models.ts";

// Fixture mirrors the live glm-5.3 catalog entry (2026-08), normalized by the
// loader: glm-5.3 advertises thinking tiers.
const GLM53: CatalogModel = {
  id: "glm-5.3",
  name: "GLM 5.3",
  capabilities: { tools: true, thinking: true, vision: false },
  context: 1024 * 1024,
  maxOutput: 131072,
  reasoningOptions: ["low", "high", "max"],
  releaseDate: "2026-08-14",
};

// Official Ollama Cloud rate (USD per 1M) — embedded in the catalog entry's
// cost block and normalized into `cost` by the loader. The knob is opt-out:
// default on, "off" is the only off, legacy "reference" keeps pricing on.
const OFFICIAL: PricingRate = {
  input: 0.44,
  output: 1.32,
  cachedInput: 0.014,
};

describe("toModelRecord", () => {
  test("campos base del runtime de opencode 2.x", () => {
    const r = toModelRecord(GLM53);
    expect(r.id).toBe("glm-5.3");
    expect(r.modelID).toBe("glm-5.3");
    expect(r.providerID).toBe("ollama-cloud");
    expect(r.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(r.settings).toEqual({ provider: "ollama-cloud" });
    expect(r.status).toBe("active");
    expect(r.enabled).toBe(true);
    expect(r.limit).toEqual({ context: 1024 * 1024, output: 131072 });
  });

  test("cost es un array de tiers con el contrato de precios de siempre", () => {
    const priced = { ...GLM53, cost: OFFICIAL };
    expect(toModelRecord(priced).cost).toEqual([
      { input: 0.44, output: 1.32, cache: { read: 0.014, write: 0 } },
    ]);
    expect(toModelRecord(priced, "off").cost).toEqual([
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ]);
    expect(toModelRecord(GLM53).cost).toEqual([
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ]);
  });

  test("rate sin cachedInput → cache.read 0, nunca NaN", () => {
    const { cachedInput: _drop, ...noCache } = OFFICIAL;
    expect(toModelRecord({ ...GLM53, cost: noCache }).cost[0].cache).toEqual({
      read: 0,
      write: 0,
    });
  });

  test("releaseDate ISO → time.released en ms; fecha basura omite el bloque", () => {
    expect(toModelRecord(GLM53).time).toEqual({
      released: Date.parse("2026-08-14"),
    });
    expect(
      toModelRecord({ ...GLM53, releaseDate: "nonsense" }).time,
    ).toBeUndefined();
  });

  test("thinking → compatibility.reasoning + variants como array de esfuerzos", () => {
    const r = toModelRecord(GLM53);
    expect(r.compatibility).toEqual({ reasoningField: "reasoning" });
    expect(r.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ]);
    const plain = toModelRecord({
      ...GLM53,
      reasoningOptions: [],
      capabilities: { tools: true, thinking: false, vision: false },
    });
    expect(plain.compatibility).toBeUndefined();
    expect(plain.variants).toBeUndefined();
  });

  test("vision amplía capabilities.input", () => {
    const vision = toModelRecord({
      ...GLM53,
      capabilities: { tools: true, thinking: false, vision: true },
    });
    expect(vision.capabilities.input).toEqual(["text", "image"]);
    expect(toModelRecord(GLM53).capabilities.input).toEqual(["text"]);
  });
});
