import { describe, expect, test } from "bun:test";
import {
  EMPTY_SESSION_LINE,
  configuredCatalogUrl,
  formatLiveLine,
  formatModelCard,
  formatRelativeAge,
  formatStatsDialogBody,
  formatStepRow,
  pickSessionFile,
  pickTuiFeatures,
  pricingActive,
  pricingKnob,
} from "./tui-display.ts";
import type { HandoffFile } from "./handoff.ts";
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
    // el promedio abarca cambios de modelo (sin desglose por diseño): el
    // header solo atribuye el ÚLTIMO modelo, no es dueño de las cifras
    expect(body).toContain("Session · last model glm-5.3");
    expect(body).toContain("38.2 tok/s · TTFT 380 ms · Session average");
    expect(body).toContain("5 responses · 1.8k t output");
    expect(body).toContain("1m ago   31.2 tok/s · TTFT 310 ms · 312 t");
  });

  test("estado vacío textual; sin steps el header cae a —", () => {
    const body = formatStatsDialogBody(
      summary({ steps: 0 }),
      [],
      "glm-5.3",
      NOW,
    );
    expect(body).toContain("Session · last model glm-5.3");
    expect(body).toContain(EMPTY_SESSION_LINE);
    expect(formatStatsDialogBody(summary({ steps: 0 }), [])).toContain(
      "Session · last model —",
    );
  });

  test("sin filas no queda separador huérfano bajo el head", () => {
    const body = formatStatsDialogBody(summary(), [], "glm-5.3", NOW);
    expect(body.endsWith("output")).toBe(true);
  });

  test("las respuestas directas (single-chunk) se marcan (direct)", () => {
    expect(formatStepRow(step({ source: "wire-nostream" }), NOW)).toContain(
      "(direct)",
    );
    expect(formatStepRow(step({ source: "wire" }), NOW)).not.toContain(
      "(direct)",
    );
  });

  test("ages legibles (relativo); futuro y presente → now", () => {
    expect(formatRelativeAge(NOW - 5_000, NOW)).toBe("5s ago");
    expect(formatRelativeAge(NOW - 90_000, NOW)).toBe("1m ago");
    expect(formatRelativeAge(NOW - 7_200_000, NOW)).toBe("2h 0m ago");
    expect(formatRelativeAge(NOW + 30_000, NOW)).toBe("now");
    expect(formatRelativeAge(NOW, NOW)).toBe("now");
  });
});

describe("pickSessionFile (guard: sin sesión activa no se muestra NADA)", () => {
  const file: HandoffFile = {
    sessionID: "s1",
    generatedAt: "2026-09-03T00:00:00.000Z",
    summary: summary(),
    steps: [],
  };

  test("sin sesión activa → null (el arranque nunca muestra un archivo)", () => {
    expect(pickSessionFile(file, null)).toBeNull();
  });

  test("sesión coincidente → el archivo", () => {
    expect(pickSessionFile(file, "s1")).toBe(file);
  });

  test("sesión distinta o archivo ausente → null", () => {
    expect(pickSessionFile(file, "s2")).toBeNull();
    expect(pickSessionFile(null, "s1")).toBeNull();
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
    pricing: { input: 0.7, output: 1.75, cachedInput: 0.02 },
    ...over,
  });

  test("cuantización declarada + nota al pie + tarifa oficial según knob", () => {
    const card = formatModelCard(model(), true);
    expect(card).toContain("FP8 (declared)");
    expect(card).toContain("quantization declared by Ollama. Does not");
    // base decimal (1M = 1_000_000): 1_048_576 → 1M, 131_072 → 131k (no 128k)
    expect(card).toContain("1M");
    expect(card).toContain("131k");
    expect(card).toContain(
      "Official rate     $0.7 in · $0.02 cached · $1.75 out per 1M",
    );
    const off = formatModelCard(model(), false);
    expect(off).not.toContain("Official rate");
  });

  test("sin cachedInput la columna se muestra como —, nunca inventa", () => {
    const noCache = model({ pricing: { input: 0.7, output: 1.75 } });
    expect(formatModelCard(noCache, true)).toContain(
      "Official rate     $0.7 in · — cached · $1.75 out per 1M",
    );
  });

  test("fuera de catálogo (pricing null) → guiones, nunca 0", () => {
    expect(formatModelCard(model({ pricing: null }), true)).toContain(
      "Official rate     — in · — cached · — out per 1M",
    );
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

describe("pricingKnob (la regla solo-off vive en UN lado, code review)", () => {
  test("solo el literal off apaga; legacy reference y desconocidos quedan en on", () => {
    expect(pricingKnob(undefined)).toBe("on");
    expect(pricingKnob("reference")).toBe("on");
    expect(pricingKnob("off")).toBe("off");
  });
});

describe("configuredCatalogUrl (la ficha usa las mismas puertas que el server)", () => {
  test("toma el catalogUrl de la propia entrada TUI", () => {
    expect(
      configuredCatalogUrl(
        { plugin: [] },
        { catalogUrl: "https://x/cat.json" },
      ),
    ).toBe("https://x/cat.json");
  });

  test("escanea el catalogUrl configurado en la entrada server", () => {
    const config = {
      plugin: [
        [
          "@srnoob2570/opencode-ollama-cloud",
          { catalogUrl: "https://y/cat.json" },
        ],
        ["@srnoob2570/opencode-ollama-cloud/tui", {}],
      ],
    };
    expect(configuredCatalogUrl(config, {})).toBe("https://y/cat.json");
  });

  test("ignora catalogUrl de otros paquetes y valores no-string", () => {
    const config = {
      plugin: [["otro-plugin", { catalogUrl: "https://z/cat.json" }]],
    };
    expect(configuredCatalogUrl(config, {})).toBeUndefined();
    expect(
      configuredCatalogUrl(
        {
          plugin: [["@srnoob2570/opencode-ollama-cloud", { catalogUrl: 42 }]],
        },
        {},
      ),
    ).toBeUndefined();
  });

  test("sin configuración → undefined (mirrors por defecto)", () => {
    expect(configuredCatalogUrl(undefined, {})).toBeUndefined();
    expect(configuredCatalogUrl({ plugin: [] }, {})).toBeUndefined();
  });
});

describe("pricingActive (opt-out: on por defecto, solo `off` apaga)", () => {
  test("default on sin config ni opciones (la tarifa es oficial, no pide permiso)", () => {
    expect(pricingActive(undefined, {})).toBe(true);
    expect(pricingActive({ plugin: [] }, undefined)).toBe(true);
  });

  test("pricing: off en la entrada TUI apaga", () => {
    expect(pricingActive({ plugin: [] }, { pricing: "off" })).toBe(false);
  });

  test("pricing: off en CUALQUIER entrada del paquete apaga", () => {
    const config = {
      plugin: [
        ["@srnoob2570/opencode-ollama-cloud", { pricing: "off" }],
        ["@srnoob2570/opencode-ollama-cloud/tui", {}],
      ],
    };
    expect(pricingActive(config, {})).toBe(false);
  });

  test("el alias legacy `reference` y los valores desconocidos NO apagan", () => {
    const config = {
      plugin: [["@srnoob2570/opencode-ollama-cloud", { pricing: "reference" }]],
    };
    expect(pricingActive(config, {})).toBe(true);
    expect(pricingActive({ plugin: [] }, { pricing: "reference" })).toBe(true);
  });

  test("otro paquete con pricing: off no apaga el nuestro", () => {
    const config = {
      plugin: [["otro-plugin", { pricing: "off" }]],
    };
    expect(pricingActive(config, {})).toBe(true);
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
