import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogModel } from "../scripts/test-fixtures.ts";
import type { CatalogModel } from "./catalog.ts";
// Helpers live outside the entry module: opencode's legacy plugin loader
// calls EVERY exported function of ./index.ts as a plugin factory with
// (PluginInput, options), so that module must export only the default
// factory (see the note there).
import { createStatsDebugSink, statsDebugSinkFor } from "./debug-sink.ts";
import { toModelV2 } from "./models.ts";
import opencodeOllamaCloud from "./index.ts";

// Fixture mirrors the live glm-5.3 catalog entry (2026-08): glm-5.3 advertises
// thinking tiers, glm-5.1 thinking has no effort levels (toggle only).
const GLM53: CatalogModel = catalogModel("glm-5.3", {
  name: "GLM 5.3",
  created: 1787929200,
  capabilities: { tools: true, thinking: true, vision: false },
  context: 1048576,
  maxOutput: 131072,
  reasoningOptions: ["low", "high", "max"],
  releaseDate: "2026-08-14",
});

const GLM51: CatalogModel = { ...GLM53, id: "glm-5.1", reasoningOptions: [] };

describe("toModelV2 variants", () => {
  test("effort tiers become rotatable variants with openai-compatible payloads", () => {
    const model = toModelV2(GLM53);
    expect(Object.keys(model.variants ?? {})).toEqual(["low", "high", "max"]);
    expect(model.variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    });
  });

  test("thinking without effort levels yields no variants (nothing to rotate)", () => {
    expect(Object.keys(toModelV2(GLM51).variants ?? {})).toEqual([]);
  });

  test("non-string entries are dropped (isCatalog only checks the array shape)", () => {
    const dirty = {
      ...GLM53,
      reasoningOptions: ["low", 42, null, "high"],
    } as unknown as CatalogModel;
    expect(Object.keys(toModelV2(dirty).variants ?? {})).toEqual([
      "low",
      "high",
    ]);
  });

  test("thinking capability is still exposed as capabilities.reasoning", () => {
    expect(toModelV2(GLM53).capabilities.reasoning).toBe(true);
  });
});

describe("toModelV2 interleaved", () => {
  test("thinking models replay reasoning via ollama's `reasoning` wire field", () => {
    expect(toModelV2(GLM53).capabilities.interleaved).toEqual({
      field: "reasoning",
    });
  });

  test("non-thinking models keep interleaved off (no reasoning parts to replay)", () => {
    const noThink = {
      ...GLM53,
      capabilities: { tools: true, thinking: false, vision: false },
    };
    expect(toModelV2(noThink).capabilities.interleaved).toBe(false);
  });
});
// Official Ollama Cloud rate (a catalog/pricing.json entry, USD per 1M) —
// joined by id at plugin load and passed to toModelV2 as the `rate`. The
// knob is opt-out: default on, "off" is the only off, legacy "reference"
// keeps pricing on.
const OFFICIAL = {
  input: 0.44,
  output: 1.32,
  cachedInput: 0.014,
  unit: "per-1M" as const,
  source: "https://ollama.com/pricing",
  asOf: "2026-09-01",
};

describe("toModelV2 pricing", () => {
  test("default (on) wires the official rate into the cost counter", () => {
    expect(toModelV2(GLM53, undefined, OFFICIAL).cost).toEqual({
      input: 0.44,
      output: 1.32,
      cache: { read: 0.014, write: 0 },
    });
  });

  test("pricing: off keeps the counter at zero even with a rate", () => {
    expect(toModelV2(GLM53, "off", OFFICIAL).cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
  });

  test("model without a table entry stays at $0 even with pricing on (no partial estimates)", () => {
    expect(toModelV2(GLM53).cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
  });

  test("rate without cachedInput → cache.read 0, never NaN", () => {
    const { cachedInput: _drop, ...noCache } = OFFICIAL;
    expect(toModelV2(GLM53, undefined, noCache).cost.cache).toEqual({
      read: 0,
      write: 0,
    });
  });
});

// Stats knob (ticket 08): default ON, opt-out. In "off" the plugin must be
// behavior-identical to pre-stats: no provider options.fetch, no event hook.
describe("stats knob", () => {
  const make = async (opts: Record<string, unknown>) => {
    const plugin = await opencodeOllamaCloud({} as never, opts as never);
    const cfg = { provider: {} as Record<string, Record<string, unknown>> };
    await (plugin as any).config(cfg);
    return { plugin, cfg };
  };

  test("default (on): inyecta fetch en el provider y registra el event sink", async () => {
    const { plugin, cfg } = await make({});
    expect(
      (cfg.provider["ollama-cloud"].options as Record<string, unknown>).fetch,
    ).toBeTypeOf("function");
    expect((plugin as any).event).toBeTypeOf("function");
  });

  test("stats: off — plugin reducido a provider/catálogo (cero overhead)", async () => {
    const { plugin, cfg } = await make({ stats: "off" });
    expect(cfg.provider["ollama-cloud"].options).toBeUndefined();
    expect((plugin as any).event).toBeUndefined();
  });
});

// statsDebug knob (claim instrumentation): default OFF. With the knob off no
// sink exists, so no stats-debug.log byte can ever be written.
describe("statsDebug knob", () => {
  test("off (default): sin sink — cero escrituras posibles", () => {
    expect(statsDebugSinkFor(undefined)).toBeUndefined();
    expect(statsDebugSinkFor(false)).toBeUndefined();
    expect(statsDebugSinkFor(0)).toBeUndefined();
    expect(statsDebugSinkFor("")).toBeUndefined();
  });

  test("truthy → sink; el knob viaja al capture sin romper la creación del plugin", async () => {
    expect(typeof statsDebugSinkFor(true)).toBe("function");
    expect(typeof statsDebugSinkFor(1)).toBe("function");
    const plugin = await opencodeOllamaCloud(
      {} as never,
      {
        statsDebug: true,
      } as never,
    );
    expect((plugin as any).event).toBeTypeOf("function");
  });

  test("el sink acota el archivo (~256 KB) y nunca lanza", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stats-debug-"));
    const sink = createStatsDebugSink(dir);
    expect(() => sink("claim test line")).not.toThrow();
    // line > 256 KB → the file gets truncated FROM THE FRONT: the head line
    // is gone by design, but the file never grows past the cap
    expect(() => sink("x".repeat(300 * 1024))).not.toThrow();
    const { statSync, readFileSync } = await import("node:fs");
    const file = join(dir, "stats-debug.log");
    expect(statSync(file).size).toBeLessThanOrEqual(260 * 1024);
    expect(readFileSync(file, "utf8")).toContain("xxx");
  });
});
