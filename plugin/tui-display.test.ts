import { describe, expect, test } from "bun:test";
import {
  EMPTY_SESSION_LINE,
  formatLiveLine,
  formatModelCard,
  formatRelativeAge,
  formatStatsDialogBody,
  formatStepRow,
  pickTuiFeatures,
  referencePricingActive,
} from "./tui-display.ts";
import type { SessionSummary, StepMeasurement } from "./stats.ts";

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  steps: 5,
  tokensOutTotal: 1820,
  decodeMsTotal: 47_600,
  avgTps: 38.2,
  avgTtftMs: 380,
  ...over,
});

const step = (over: Partial<StepMeasurement> = {}): StepMeasurement => ({
  sessionID: "s1",
  providerID: "ollama-cloud",
  modelID: "glm-5.3",
  ttftMs: 310,
  tokensOut: 312,
  decodeMs: 10_000,
  source: "wire",
  ts: 1_790_000_000_000,
  ...over,
});

const NOW = 1_790_000_000_000 + 60_000; // un minuto después del último step

describe("línea live (mock §1 — formato ratificado)", () => {
  test("con datos: un decimal, ms entero, etiqueta Session average", () => {
    expect(formatLiveLine(summary())).toBe(
      "38.2 tok/s · TTFT 380 ms · Session average",
    );
  });

  test("sesión vacía: guiones, nunca oculta", () => {
    expect(formatLiveLine(null)).toBe("— tok/s · TTFT — ms · Session average");
    expect(formatLiveLine(summary({ steps: 0 }))).toBe(
      "— tok/s · TTFT — ms · Session average",
    );
  });
});

describe("diálogo /stats (mock §2)", () => {
  test("resumen arriba + últimas respuestas debajo", () => {
    const body = formatStatsDialogBody(
      summary(),
      [step({ ts: 1_790_000_000_000 })],
      "glm-5.3",
      NOW,
    );
    expect(body).toContain("Session · glm-5.3");
    expect(body).toContain("38.2 tok/s · TTFT 380 ms · Session average");
    expect(body).toContain("5 responses · 1.8k t output");
    expect(body).toContain("1m ago   31.2 tok/s · TTFT 310 ms · 312 t");
  });

  test("estado vacío textual", () => {
    const body = formatStatsDialogBody(
      summary({ steps: 0 }),
      [],
      "glm-5.3",
      NOW,
    );
    expect(body).toContain(EMPTY_SESSION_LINE);
  });

  test("las mediciones event se marcan en el detalle", () => {
    expect(formatStepRow(step({ source: "event" }), NOW)).toContain("(event)");
  });

  test("ages legibles (relativo)", () => {
    expect(formatRelativeAge(NOW - 5_000, NOW)).toBe("5s ago");
    expect(formatRelativeAge(NOW - 90_000, NOW)).toBe("1m ago");
    expect(formatRelativeAge(NOW - 7_200_000, NOW)).toBe("2h 0m ago");
  });
});

describe("ficha /model (mock §3 — tres estados de cuantización)", () => {
  const model = (
    over: Parameters<typeof formatModelCard>[0] extends infer M
      ? Partial<M>
      : never = {},
  ) => ({
    id: "glm-5.3",
    name: "GLM 5.3",
    family: "glm",
    releaseDate: "2026-08-14",
    quantization: "FP8",
    context: 1_048_576,
    maxOutput: 131_072,
    capabilities: { tools: true, thinking: true, vision: false },
    pricing: { input: 0.7, output: 1.75 },
    ...over,
  });

  test("cuantización declarada + nota al pie + precio según knob", () => {
    const card = formatModelCard(model(), true);
    expect(card).toContain("FP8 (declared)");
    expect(card).toContain("quantization declared by Ollama. Does not");
    expect(card).toContain("1M");
    const off = formatModelCard(model(), false);
    expect(off).not.toContain("Ref. price");
  });

  test("sin fuente defendible → desconocida; fuera de catálogo → —", () => {
    expect(
      formatModelCard(model({ quantization: "unknown" }), false),
    ).toContain("Quantization      unknown");
    expect(
      formatModelCard(model({ quantization: undefined }), false),
    ).toContain("Quantization      — (unavailable)");
  });
});

describe("pickTuiFeatures (degradación silenciosa)", () => {
  test("un api completo habilita slots y keymap", () => {
    const api = {
      slots: { register: () => {} },
      keymap: { registerLayer: () => {} },
    };
    expect(pickTuiFeatures(api)).toEqual({ slots: true, keymap: true });
  });

  test("opencode nuevo sin la API esperada → degradación, nada lanza", () => {
    expect(pickTuiFeatures(undefined)).toEqual({ slots: false, keymap: false });
    expect(pickTuiFeatures({})).toEqual({ slots: false, keymap: false });
    expect(pickTuiFeatures({ slots: {} })).toEqual({
      slots: false,
      keymap: false,
    });
  });
});

describe("referencePricingActive (el knob vive en la entrada server)", () => {
  test("descubre pricing: reference en CUALQUIER entrada del paquete", () => {
    const config = {
      plugin: [
        ["@srnoob2570/opencode-ollama-cloud", { pricing: "reference" }],
        ["@srnoob2570/opencode-ollama-cloud/tui", {}],
      ],
    };
    expect(referencePricingActive(config, {})).toBe(true);
  });

  test("lo respeta también si el usuario lo puso en la entrada TUI", () => {
    expect(
      referencePricingActive({ plugin: [] }, { pricing: "reference" }),
    ).toBe(true);
  });

  test("config sin el knob ni el plugin → false", () => {
    expect(referencePricingActive(undefined, {})).toBe(false);
    expect(
      referencePricingActive(
        { plugin: ["@srnoob2570/opencode-ollama-cloud"] },
        {},
      ),
    ).toBe(false);
  });
});
describe("ficha /model — cuantización implícita no es «declarada» (code review)", () => {
  const base = {
    id: "glm-5.2",
    name: "GLM 5.2",
    family: "glm",
    releaseDate: "2026-08",
    quantization: "FP8",
    context: 1_048_576,
    maxOutput: 131_072,
    capabilities: { tools: true, thinking: false, vision: false },
  };

  test("source implícita → etiqueta (implícita) y footer sin atribuir a Ollama", () => {
    const card = formatModelCard(
      {
        ...base,
        quantizationSource:
          "implicit-hf (zai-org/GLM-5.2-FP8 checkpoint + familia glm FP8)",
      },
      false,
    );
    expect(card).toContain("FP8 (implicit)");
    expect(card).toContain("quantization researched from public sources");
    expect(card).not.toContain("(declared)");
  });

  test("source registry mantiene «(declarada)»", () => {
    const card = formatModelCard(
      { ...base, quantizationSource: "registry-ollama" },
      false,
    );
    expect(card).toContain("FP8 (declared)");
  });
});
