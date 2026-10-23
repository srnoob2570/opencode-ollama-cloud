import { describe, expect, test } from "bun:test";
import opencodeOllamaCloud, {
  applyModels,
  pricingKnob,
  type ProviderDraft,
} from "./index.ts";
import type { ModelRecord } from "./models.ts";

// The entry is the opencode 2.x contract: {id, setup}. The V1 `server`
// factory is gone — a V1 host has nothing to run here.
describe("entrada opencode 2.x", () => {
  test("el default expone {id, setup} y ya no expone `server`", () => {
    expect(opencodeOllamaCloud.id).toBe("opencode-ollama-cloud");
    expect(typeof opencodeOllamaCloud.setup).toBe("function");
    expect("server" in opencodeOllamaCloud).toBe(false);
  });

  test("setup sin contexto (host roto) se degrada en silencio", async () => {
    await expect(opencodeOllamaCloud.setup(undefined)).resolves.toBeUndefined();
    await expect(
      opencodeOllamaCloud.setup({} as never),
    ).resolves.toBeUndefined();
  });

  test("setup sin provider.transform no hace nada (ni siquiera busca catálogo)", async () => {
    await expect(
      opencodeOllamaCloud.setup({
        options: { catalogUrl: "https://example.invalid/catalog.json" },
      } as never),
    ).resolves.toBeUndefined();
  });
});

// The transform body is the only behavior that mutates the host: it must
// only inject when the provider record exists (models.dev owns it today).
describe("applyModels (cuerpo del transform)", () => {
  const record = { id: "glm-5.3" } as ModelRecord;

  test("provider ausente → no llama a set", () => {
    let called = false;
    const draft: ProviderDraft = {
      get: () => undefined,
      models: {
        set: () => {
          called = true;
        },
      },
    };
    applyModels(draft, [record]);
    expect(called).toBe(false);
  });

  test("provider presente → set con el provider id y los records", () => {
    const calls: unknown[] = [];
    const draft: ProviderDraft = {
      get: (id) => (id === "ollama-cloud" ? {} : undefined),
      models: {
        set: (...args) => {
          calls.push(args);
        },
      },
    };
    applyModels(draft, [record]);
    expect(calls).toEqual([["ollama-cloud", [record]]]);
  });

  test("draft sin get/set o que lanza nunca propaga", () => {
    expect(() => applyModels(undefined, [record])).not.toThrow();
    expect(() => applyModels({}, [record])).not.toThrow();
    expect(() =>
      applyModels(
        {
          get: () => ({}),
          models: {
            set: () => {
              throw new Error("boom");
            },
          },
        },
        [record],
      ),
    ).not.toThrow();
  });
});

describe("pricingKnob", () => {
  test("solo el literal 'off' apaga; el resto (incluido 'reference') queda on", () => {
    expect(pricingKnob("off")).toBe("off");
    expect(pricingKnob("on")).toBe("on");
    expect(pricingKnob("reference")).toBe("on");
    expect(pricingKnob(undefined)).toBe("on");
  });
});
