import { describe, expect, test } from "bun:test";
import {
  EMPTY_SESSION_LINE,
  formatLiveLine,
  formatRelativeAge,
  formatStatsDialogBody,
  formatStepRow,
  pickSessionFile,
  pickTuiFeatures,
  pricingKnob,
  resolveSessionID,
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

describe("resolveSessionID (montaje único del slot → ruta como respaldo)", () => {
  test("los props ganan cuando traen session_id", () => {
    const route = { current: { type: "session", params: { sessionID: "sR" } } };
    expect(resolveSessionID("sP", route)).toBe("sP");
    expect(resolveSessionID("sP", undefined)).toBe("sP");
  });

  test("sin props: lee route.current.params.sessionID", () => {
    const route = { current: { type: "session", params: { sessionID: "sR" } } };
    expect(resolveSessionID(undefined, route)).toBe("sR");
    expect(resolveSessionID(null, route)).toBe("sR");
    expect(resolveSessionID("", route)).toBe("sR");
  });

  test("pantalla home (sin params) o ruta ausente → null, nunca inventa", () => {
    expect(
      resolveSessionID(undefined, { current: { type: "home" } }),
    ).toBeNull();
    expect(resolveSessionID(undefined, { current: null })).toBeNull();
    expect(resolveSessionID(undefined, {})).toBeNull();
    expect(resolveSessionID(undefined, undefined)).toBeNull();
    expect(resolveSessionID(undefined, null)).toBeNull();
  });

  test("tipos inesperados en la ruta → null (feature-detected)", () => {
    expect(
      resolveSessionID(undefined, { current: { params: { sessionID: 42 } } }),
    ).toBeNull();
    expect(
      resolveSessionID(undefined, { current: { params: "s1" } }),
    ).toBeNull();
    expect(resolveSessionID(undefined, { current: 7 })).toBeNull();
    expect(resolveSessionID(undefined, "s1")).toBeNull();
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
