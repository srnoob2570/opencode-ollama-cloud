import { describe, expect, test } from "bun:test";
import {
  isCatalog,
  toCatalogModel,
  usableModels,
  type ArtifactModel,
} from "./catalog.ts";

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
  x_ollama: { reasoning_options: ["low", "high"] },
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

// The envelope guard: structure of the document only. Per-entry damage is
// usableModels' business — a malformed entry must never reject the whole
// artifact and hide the good models behind it (the beam incident).
describe("isCatalog (envelope guard)", () => {
  const validModel = entry("glm-5.3");
  const validDoc = docWith([validModel]);

  test("accepts a well-formed artifact", () => {
    expect(isCatalog(validDoc)).toBe(true);
  });

  test("accepts an artifact carrying broken or partial model entries", () => {
    // clef:27b exactly as published 2026-10-17: no limit.output, input-only
    // cost, no decision marker yet. The document itself is fine — the bad
    // ENTRY is dropped later, by usableModels.
    const clefAsPublished = {
      ...entry("clef:27b"),
      limit: { context: 65536 },
      cost: { input: 0.24 },
    };
    expect(
      isCatalog(
        docWith([validModel, clefAsPublished as unknown as ArtifactModel]),
      ),
    ).toBe(true);
    // fully shapeless entries pass the envelope too
    expect(
      isCatalog({
        ...validDoc,
        provider: { ...validDoc.provider, models: { x: { id: 42 } } },
      }),
    ).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(isCatalog(null)).toBe(false);
    expect(isCatalog("null")).toBe(false);
  });

  test("rejects a missing or non-record models block", () => {
    for (const models of [undefined, [], "x", 42]) {
      const doc = docWith([validModel]);
      (doc.provider as Record<string, unknown>).models = models;
      expect(isCatalog(doc)).toBe(false);
    }
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

// The per-entry gate: the document loads even when some entries cannot
// serve. Broken entries are dropped with a warning — never a whole-document
// rejection; decision models are excluded by their marker.
describe("usableModels", () => {
  const good = entry("glm-5.3");
  const beam = entry("beam");

  test("one broken entry never hides the good ones (the beam incident)", () => {
    const clefAsPublished = {
      ...entry("clef:27b"),
      limit: { context: 65536 },
      cost: { input: 0.24 },
    };
    const models = usableModels(
      docWith([good, clefAsPublished as unknown as ArtifactModel, beam])
        .provider.models,
    );
    expect(models.map((m) => m.id).sort()).toEqual(["beam", "glm-5.3"]);
  });

  test("drops entries failing a served-shape requirement", () => {
    const cases: Record<string, unknown>[] = [
      { id: 42 }, // shapeless
      { ...good, limit: { context: 0, output: 131072 } },
      { ...good, limit: { context: 65536 } }, // no limit.output
      { ...good, limit: { context: 65536, output: 0 } },
      { ...good, modalities: { input: "text" } },
      { ...good, reasoning: 1 },
      { ...good, x_ollama: { reasoning_options: "low" } },
    ];
    for (const raw of cases) expect(usableModels({ bad: raw })).toEqual([]);
    const noName = { ...good } as Record<string, unknown>;
    delete noName.name;
    const noDate = { ...good } as Record<string, unknown>;
    delete noDate.release_date;
    expect(usableModels({ a: noName, b: noDate })).toEqual([]);
  });

  test("absent x_ollama or extra metadata stays usable (only consumed shapes are gated)", () => {
    for (const raw of [
      { ...good, x_ollama: undefined },
      { ...good, x_ollama: {} },
      { ...good, x_ollama: { quantization: "Some-New-Format-2049" } },
      { ...good, x_ollama: { some_future_field: 42 } },
    ]) {
      expect(usableModels({ m: raw })).toHaveLength(1);
    }
  });

  test("garbage cost never drops a model — it serves rateless ($0)", () => {
    const models = usableModels({ m: { ...good, cost: { input: 0 } } });
    expect(models).toHaveLength(1);
    expect(models[0].cost).toBeUndefined();
  });
});

// Decision models (served via /v1/systemone, not /api/chat) are excluded
// by the artifact's x_ollama.decision marker — opencode cannot use them.
describe("usableModels decision exclusion", () => {
  test("excludes an otherwise valid entry marked decision: true", () => {
    const decision = entry("clef:27b", {
      limit: { context: 65536, output: 65536 },
      x_ollama: { decision: true },
    });
    const models = usableModels(
      docWith([decision, entry("beam")]).provider.models,
    );
    expect(models.map((m) => m.id)).toEqual(["beam"]);
  });

  test("excludes a marked decision entry even with an unservable shape (marker first)", () => {
    // the shape the catalog will publish once it carries the marker:
    // limit.output omitted by design (never serves /api/chat)
    const clefMarked = {
      ...entry("clef:27b"),
      limit: { context: 65536 },
      cost: { input: 0.24 },
      x_ollama: { decision: true },
    };
    const models = usableModels(
      docWith([clefMarked as unknown as ArtifactModel, entry("beam")]).provider
        .models,
    );
    expect(models.map((m) => m.id)).toEqual(["beam"]);
  });

  test("a non-true decision value keeps a served-shape entry (tolerant read)", () => {
    const odd = entry("glm-5.3", {
      x_ollama: { decision: "yes" as unknown as boolean },
    });
    expect(usableModels(docWith([odd]).provider.models)).toHaveLength(1);
  });
});

// The normalization seam: artifact entry → the plugin's internal view.
describe("toCatalogModel", () => {
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

  test("reasoning_options filter non-strings (the gate checks the array shape only)", () => {
    const dirty = entry("glm-5.3", {
      x_ollama: { reasoning_options: ["low", 42, null, "high"] },
    });
    expect(toCatalogModel(dirty).reasoningOptions).toEqual(["low", "high"]);
  });
});

// All-or-nothing cost adoption: the cost block is one claim — partial or
// malformed adopts nothing (rateless $0, the documented safe default)
// instead of a wrong price. output/cache_read of 0 are legitimate rates
// (free tokens publish as $0).
describe("toCatalogModel cost adoption", () => {
  test("adopts a complete sane cost block (cache_read → cachedInput)", () => {
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
  });

  test("adopts free-token rates: output 0 and cache_read 0", () => {
    expect(
      toCatalogModel(
        entry("clef:27b", { cost: { input: 0.24, output: 0, cache_read: 0 } }),
      ).cost,
    ).toEqual({ input: 0.24, output: 0, cachedInput: 0 });
  });

  test("input-only cost (what clef:27b publishes today) adopts nothing", () => {
    expect(
      toCatalogModel(entry("clef:27b", { cost: { input: 0.24 } })).cost,
    ).toBeUndefined();
  });

  test("absent cost stays absent", () => {
    expect(toCatalogModel(entry("glm-5.3")).cost).toBeUndefined();
  });

  test("garbage rates adopt nothing but the model survives rateless", () => {
    for (const cost of [
      { input: 0 },
      { input: -1 },
      { input: Number.NaN },
      { input: 1e999 },
      { input: 0.24, output: -1 },
      { input: 0.24, output: Number.NaN },
      { input: 0.24, output: 1, cache_read: -0.01 },
      { input: 0.24, output: 1, cache_read: Number.POSITIVE_INFINITY },
    ]) {
      const m = toCatalogModel(entry("glm-5.3", { cost }));
      expect(m.cost).toBeUndefined();
      expect(m.id).toBe("glm-5.3");
    }
  });
});
