import { describe, expect, test } from "bun:test";
import { PROVIDER_ID, type Catalog, type CatalogModel } from "./catalog.ts";
import {
  applyModelPatch,
  applyV2Catalog,
  mergeVariants,
  modelPatch,
  releaseMs,
  zeroCostArray,
} from "./v2-catalog.ts";
import type {
  V2CatalogEditor,
  V2CatalogProviderRecord,
  V2ModelInfo,
} from "./v2-types.ts";

const catalogModel = (
  id: string,
  overrides: Partial<CatalogModel> = {},
): CatalogModel => ({
  id,
  name: "GLM 5.3",
  family: id,
  capabilities: { tools: true, thinking: true, vision: false },
  input: ["text"],
  context: 1024 * 1024,
  maxOutput: 131072,
  reasoningOptions: ["low", "high"],
  releaseDate: "2026-08-14",
  ...overrides,
});

const catalogOf = (models: CatalogModel[]): Catalog => ({
  generatedAt: "2026-09-05T11:54:37.396Z",
  modelsHash:
    "e06ea128b326f65bf969a63418eba2277f53ca5e4b266ee92d049054d45609a4",
  models,
});

/** Minimal in-memory stand-in for the V2 catalog editor, mirroring the
 * host's upsert defaults closely enough to exercise the adapter. */
const createEditor = (
  models: Record<string, Partial<V2ModelInfo>> = {},
): {
  editor: V2CatalogEditor;
  record: V2CatalogProviderRecord;
  map: Map<string, V2ModelInfo>;
} => {
  const map = new Map<string, V2ModelInfo>();
  for (const [id, overrides] of Object.entries(models)) {
    map.set(id, {
      id,
      modelID: id,
      providerID: PROVIDER_ID,
      name: id,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 200000, output: 32000 },
      ...overrides,
    });
  }
  const record: V2CatalogProviderRecord = {
    provider: {
      id: PROVIDER_ID,
      name: "Ollama Cloud",
      package: "aisdk:@ai-sdk/openai-compatible",
      activation: "auto",
      settings: { baseURL: "https://ollama.com/v1" },
    },
    models: map,
  };
  const editor: V2CatalogEditor = {
    provider: {
      list: () => [record],
      get: (id) => (id === PROVIDER_ID ? record : undefined),
      update: (id, fn) => {
        if (id !== PROVIDER_ID) throw new Error(`unknown provider ${id}`);
        fn(record.provider);
      },
      remove: () => {},
    },
    model: {
      get: (providerID, modelID) =>
        providerID === PROVIDER_ID ? map.get(modelID) : undefined,
      update: (providerID, modelID, fn) => {
        if (providerID !== PROVIDER_ID)
          throw new Error(`unknown provider ${providerID}`);
        let model = map.get(modelID);
        if (!model) {
          model = {
            id: modelID,
            modelID,
            providerID,
            name: modelID,
            capabilities: {
              tools: true,
              input: ["text", "image"],
              output: ["text"],
            },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200000, output: 32000 },
          };
          map.set(modelID, model);
        }
        fn(model);
      },
      remove: () => {},
    },
  };
  return { editor, record, map };
};

describe("releaseMs", () => {
  test("converts an ISO day to epoch ms", () => {
    expect(releaseMs("2026-08-14")).toBe(Date.parse("2026-08-14"));
  });

  test("unparseable dates degrade to 0, never NaN", () => {
    expect(releaseMs("not-a-date")).toBe(0);
    expect(releaseMs("")).toBe(0);
  });
});

describe("modelPatch", () => {
  test("pricing on: official rate feeds the cost array, cache.read from cache_read", () => {
    const patch = modelPatch(
      catalogModel("glm-5.3", {
        cost: { input: 1.4, output: 4.4, cachedInput: 0.26 },
      }),
      "on",
    );
    expect(patch.cost).toEqual([
      { input: 1.4, output: 4.4, cache: { read: 0.26, write: 0 } },
    ]);
  });

  test("pricing on without cachedInput: cache.read is 0, never missing", () => {
    const patch = modelPatch(
      catalogModel("glm-5.3", { cost: { input: 1.4, output: 4.4 } }),
      "on",
    );
    expect(patch.cost[0].cache.read).toBe(0);
  });

  test("pricing off: rateless even when the artifact carries a rate", () => {
    const patch = modelPatch(
      catalogModel("glm-5.3", { cost: { input: 1.4, output: 4.4 } }),
      "off",
    );
    expect(patch.cost).toEqual(zeroCostArray());
  });

  test("no cost block: rateless with pricing on too (no partial estimates)", () => {
    const patch = modelPatch(catalogModel("glm-5.3"), "on");
    expect(patch.cost).toEqual(zeroCostArray());
  });

  test("limits, capabilities and variants come from the artifact", () => {
    const patch = modelPatch(
      catalogModel("deepseek-v4.1-flash", {
        input: ["text", "image"],
        capabilities: { tools: true, thinking: true, vision: true },
      }),
      "on",
    );
    expect(patch.limit).toEqual({ context: 1024 * 1024, output: 131072 });
    expect(patch.capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    });
    expect(patch.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
    expect(patch.status).toBe("active");
    expect(patch.released).toBe(Date.parse("2026-08-14"));
  });

  test("a model without reasoning options declares no variants", () => {
    const patch = modelPatch(
      catalogModel("gpt-oss:20b", { reasoningOptions: [] }),
      "on",
    );
    expect(patch.variants).toBeUndefined();
  });
});

describe("mergeVariants", () => {
  test("declared ids are upserted, undeclared ids survive", () => {
    const merged = mergeVariants(
      [
        { id: "max", settings: { reasoningEffort: "max", custom: true } },
        { id: "user", settings: { reasoningEffort: "user" } },
      ],
      [{ id: "max", settings: { reasoningEffort: "max" } }, { id: "low" }],
    );
    expect(merged).toEqual([
      { id: "max", settings: { reasoningEffort: "max", custom: true } },
      { id: "user", settings: { reasoningEffort: "user" } },
      { id: "low" },
    ]);
  });
});

describe("applyModelPatch", () => {
  test("mutates a fresh upsert in place (no shared cost arrays)", () => {
    const a = { cost: zeroCostArray() };
    const b = { cost: zeroCostArray() };
    applyModelPatch(a as V2ModelInfo, modelPatch(catalogModel("a"), "off"));
    applyModelPatch(b as V2ModelInfo, modelPatch(catalogModel("b"), "off"));
    expect(a.cost).not.toBe(b.cost);
    expect(a.cost[0]).not.toBe(b.cost[0]);
  });
});

describe("applyV2Catalog", () => {
  test("upserts artifact models, patches fields and keeps provider identity", () => {
    const { editor, map, record } = createEditor({
      "modelsdev-only": {},
    });
    applyV2Catalog(
      editor,
      catalogOf([
        catalogModel("deepseek-v4.1-flash", {
          name: "Deepseek V4.1 Flash",
          cost: { input: 0.15, output: 0.6, cachedInput: 0.003 },
        }),
      ]),
      "on",
    );
    const model = map.get("deepseek-v4.1-flash");
    expect(model?.name).toBe("Deepseek V4.1 Flash");
    expect(model?.limit).toEqual({ context: 1024 * 1024, output: 131072 });
    expect(model?.cost).toEqual([
      { input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } },
    ]);
    expect(model?.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
    // non-artifact models stay but are rateless (our rate or nothing)
    expect(map.get("modelsdev-only")?.cost).toEqual(zeroCostArray());
    // provider identity is ours, never the artifact block
    expect(record.provider.name).toBe("Ollama Cloud");
    expect(record.provider.settings?.baseURL).toBe("https://ollama.com/v1");
  });

  test("catalog null: every ollama-cloud model is rateless", () => {
    const { editor, map } = createEditor({ "glm-5.3": {} });
    applyV2Catalog(editor, null, "on");
    expect(map.get("glm-5.3")?.cost).toEqual(zeroCostArray());
  });

  test("pricing off zeroes artifact models too", () => {
    const { editor, map } = createEditor();
    applyV2Catalog(
      editor,
      catalogOf([
        catalogModel("glm-5.3", { cost: { input: 1.4, output: 4.4 } }),
      ]),
      "off",
    );
    expect(map.get("glm-5.3")?.cost).toEqual(zeroCostArray());
  });

  test("missing provider: warns and does not throw", () => {
    const empty: V2CatalogEditor = {
      provider: {
        list: () => [],
        get: () => undefined,
        update: () => {},
        remove: () => {},
      },
      model: { get: () => undefined, update: () => {}, remove: () => {} },
    };
    expect(() => applyV2Catalog(empty, null, "on")).not.toThrow();
  });
});
