import { describe, expect, test } from "bun:test";
import { isCatalog, toCatalogModel, type ArtifactModel } from "./catalog.ts";

// Fixture mirrors the live artifact shape (models.dev shape + x_ollama),
// published by srnoob2570/ollama-cloud-catalog.
const entry = (
  id: string,
  overrides: Partial<ArtifactModel> = {},
): ArtifactModel => ({
  id,
  name: "GLM 5.3",
  attachment: false,
  reasoning: true,
  tool_call: true,
  limit: { context: 1024 * 1024, output: 131072 },
  modalities: { input: ["text"] },
  release_date: "2026-08-14",
  x_ollama: { quantization: "FP8", reasoning_options: ["low", "high"] },
  ...overrides,
});

const docWith = (models: ArtifactModel[]) => ({
  provider: {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    npm: "@ai-sdk/openai-compatible",
    doc: "https://ollama.com/docs/cloud",
    env: ["OLLAMA_API_KEY"],
    models: Object.fromEntries(models.map((m) => [m.id, m])),
  },
  x_ollama: {
    generated_at: "2026-09-05T11:54:37.396Z",
    models_hash:
      "e06ea128b326f65bf969a63418eba2277f53ca5e4b266ee92d049054d45609a4",
  },
});

describe("isCatalog", () => {
  const validModel = entry("glm-5.3");
  const validDoc = docWith([validModel]);

  test("accepts a well-formed artifact", () => {
    expect(isCatalog(validDoc)).toBe(true);
  });

  test("rejects context 0 (regression guard)", () => {
    const bad = docWith([{ ...validModel, limit: { context: 0, output: 1 } }]);
    expect(isCatalog(bad)).toBe(false);
  });

  test("rejects missing release_date (consumed as a required string downstream)", () => {
    const noDate: Record<string, unknown> = { ...validModel };
    delete noDate.release_date;
    expect(isCatalog(docWith([noDate as unknown as ArtifactModel]))).toBe(
      false,
    );
  });

  test("rejects missing name and non-boolean flags", () => {
    const noName: Record<string, unknown> = { ...validModel };
    delete noName.name;
    expect(isCatalog(docWith([noName as unknown as ArtifactModel]))).toBe(
      false,
    );
    expect(
      isCatalog(
        docWith([{ ...validModel, reasoning: 1 } as unknown as ArtifactModel]),
      ),
    ).toBe(false);
  });

  test("rejects non-objects and shapeless models", () => {
    expect(isCatalog(null)).toBe(false);
    expect(isCatalog("null")).toBe(false);
    expect(
      isCatalog({
        ...validDoc,
        provider: { ...validDoc.provider, models: { x: { id: 42 } } },
      }),
    ).toBe(false);
  });

  test("rejects a broken models_hash gate fingerprint", () => {
    for (const hash of [
      undefined,
      "",
      "deadbeef",
      "E06EA128".padEnd(64, "0"),
    ]) {
      const doc = docWith([validModel]);
      (doc.x_ollama as Record<string, unknown>).models_hash = hash;
      expect(isCatalog(doc)).toBe(false);
    }
  });

  test("rejects a provider block missing npm/doc or with a non-array env", () => {
    for (const key of ["npm", "doc"] as const) {
      const doc = docWith([validModel]);
      delete (doc.provider as Record<string, unknown>)[key];
      expect(isCatalog(doc)).toBe(false);
    }
    const doc = docWith([validModel]);
    (doc.provider as Record<string, unknown>).env = "OLLAMA_API_KEY";
    expect(isCatalog(doc)).toBe(false);
  });
});

// Optional quantization: absent always loads; a present one is shape-only —
// raw values and "unknown" pass, no enum, so a new Ollama format can never
// break the loader (the updater's policy: CI advises, never fails).
describe("isCatalog optional quantization", () => {
  const validModel = entry("glm-5.3");

  test("absent field loads", () => {
    expect(isCatalog(docWith([{ ...validModel, x_ollama: {} }]))).toBe(true);
  });

  test("raw values and the unknown literal load", () => {
    for (const value of ["FP8", "MXFP4", "unknown", "Some-New-Format-2049"])
      expect(
        isCatalog(
          docWith([{ ...validModel, x_ollama: { quantization: value } }]),
        ),
      ).toBe(true);
  });

  test("garbage is rejected (empty string, numbers)", () => {
    expect(
      isCatalog(docWith([{ ...validModel, x_ollama: { quantization: "" } }])),
    ).toBe(false);
    expect(
      isCatalog(
        docWith([
          {
            ...validModel,
            x_ollama: { quantization: 8 as unknown as string },
          },
        ]),
      ),
    ).toBe(false);
  });
});

// The official rate now rides INSIDE the artifact (each entry's cost block):
// the loader checks positive-finite invariants on what it consumes so a
// malformed entry never reaches the cost counter.
describe("isCatalog embedded cost", () => {
  const validModel = entry("glm-5.3-flash", {
    cost: { input: 0.03, output: 0.1, cache_read: 0.007 },
  });

  test("absent cost loads (third-party/custom catalogs stay valid)", () => {
    expect(isCatalog(docWith([{ ...validModel, cost: undefined }]))).toBe(true);
  });

  test("zero, negative, NaN and Infinity rates are rejected", () => {
    for (const over of [
      { input: 0, output: 1 },
      { input: -1, output: 1 },
      { input: Number.NaN, output: 1 },
      { input: 1, output: 1e999 },
    ]) {
      expect(isCatalog(docWith([{ ...validModel, cost: over }]))).toBe(false);
    }
  });

  test("cache_read is optional but must be positive-finite", () => {
    expect(
      isCatalog(docWith([{ ...validModel, cost: { input: 1, output: 1 } }])),
    ).toBe(true);
    expect(
      isCatalog(
        docWith([
          { ...validModel, cost: { input: 1, output: 1, cache_read: -0.01 } },
        ]),
      ),
    ).toBe(false);
  });
});

// The normalization seam: artifact entry → the plugin's internal view.
describe("toCatalogModel", () => {
  test("family is the id base (familia[:tag], CONTEXT.md vocabulary)", () => {
    expect(toCatalogModel(entry("gpt-oss:120b")).family).toBe("gpt-oss");
    expect(toCatalogModel(entry("glm-5.3")).family).toBe("glm-5.3");
  });

  test("capabilities map from reasoning/tool_call/attachment+image modality", () => {
    expect(toCatalogModel(entry("glm-5.3")).capabilities).toEqual({
      tools: true,
      thinking: true,
      vision: false,
    });
    expect(
      toCatalogModel(entry("gemma4:31b", { attachment: true })).capabilities
        .vision,
    ).toBe(true);
    expect(
      toCatalogModel(
        entry("gemma4:31b", {
          attachment: false,
          modalities: { input: ["text", "image"] },
        }),
      ).capabilities.vision,
    ).toBe(true);
  });

  test("reasoning_options filter non-strings (isCatalog checks the array shape only)", () => {
    const dirty = entry("glm-5.3", {
      x_ollama: { reasoning_options: ["low", 42, null, "high"] },
    });
    expect(toCatalogModel(dirty).reasoningOptions).toEqual(["low", "high"]);
  });

  test("cost maps cache_read → cachedInput; absent cost stays absent", () => {
    const withCost = toCatalogModel(
      entry("deepseek-v4-flash:0731", {
        cost: { input: 0.22, output: 0.66, cache_read: 0.007 },
      }),
    );
    expect(withCost.cost).toEqual({
      input: 0.22,
      output: 0.66,
      cachedInput: 0.007,
    });
    expect(toCatalogModel(entry("glm-5.3")).cost).toBeUndefined();
  });

  test("quantization passes through raw (declared by Ollama)", () => {
    expect(toCatalogModel(entry("glm-5.3")).quantization).toBe("FP8");
    expect(
      toCatalogModel(entry("gemma4:31b", { x_ollama: {} })).quantization,
    ).toBeUndefined();
  });
});
