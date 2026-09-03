import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatsCapture } from "./capture.ts";
import { isHandoffFile } from "./handoff.ts";
import type { StepMeasurement } from "./stats.ts";

const tempDir = () => mkdtemp(join(tmpdir(), "stats-handoff-"));

// Synthetic ollama.com SSE: deltas, then the final usage chunk (opencode
// always requests include_usage), then [DONE].
const sseResponse = (chunks: string[]) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((r) =>
            setTimeout(r, chunk === chunks[chunks.length - 1] ? 5 : 2),
          );
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const sseBody = (completionTokens: number) => [
  `data: {"id":"x","choices":[{"delta":{"content":"h"}}]}`,
  `\n\ndata: {"id":"x","choices":[{"delta":{"content":"i"}}]}\n`,
  `\ndata: {"id":"x","choices":[],"usage":{"prompt_tokens":68,"completion_tokens":${completionTokens},"total_tokens":${completionTokens + 68}}}\n`,
  `\ndata: [DONE]\n`,
];

const wireRequest = (headers: Record<string, string> = {}) =>
  new Request("https://ollama.com/v1/chat/completions", {
    method: "POST",
    headers,
  });

const ROOT_SESSION_EVENT = {
  type: "session.created",
  properties: { info: { id: "s-root", parentID: null } },
};

// message.updated fixtures carry a REAL clock time: the wire correlation is
// time-based now (message.time.created ± 2 s against the pending's request ts).
const ASSISTANT_UPDATE = (
  over: Record<string, unknown> = {},
  at: number = Date.now(),
) => ({
  type: "message.updated",
  properties: {
    info: {
      id: "m1",
      sessionID: "s-root",
      role: "assistant",
      parentID: "um1",
      modelID: "glm-5.3",
      providerID: "ollama-cloud",
      mode: "build",
      agent: "build",
      time: { created: at, completed: at + 5000 },
      tokens: {
        input: 10,
        output: 120,
        reasoning: 10,
        cache: { read: 0, write: 0 },
      },
      ...over,
    },
  },
});

// settle helper: the wrapper measures inside the stream pump (ReadableStream
// start runs at construction); a short sleep lets finish()/persist land.
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("createStatsCapture — captura wire → handoff", () => {
  test("end-to-end: respuesta SSE real produce una medición wire en el handoff", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const original = globalThis.fetch;
    const seen: RequestInfo[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen.push(input as RequestInfo);
      return sseResponse(sseBody(120));
    }) as unknown as typeof fetch;
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      const response = await capture.wireFetch(
        wireRequest({ "x-session-id": "s-root" }),
        {
          method: "POST",
        },
      );
      const text = await response.text();
      // bytes passthrough untouched
      expect(text).toContain('{"id":"x"');
      expect(text).toContain("[DONE]");

      // let the stream pump settle, then the assistant message claims the pending
      await settle();
      await capture.handleEvent(ASSISTANT_UPDATE());

      const collector = capture.collectors.get("s-root");
      expect(collector?.summary().steps).toBe(1);
      expect(collector?.summary().tokensOutTotal).toBe(120);
      expect(collector?.summary().avgTps).toBeGreaterThan(0);

      // D3: the snapshot lives in the session's OWN file
      const file = await capture.store.read("s-root");
      expect(isHandoffFile(file)).toBe(true);
      expect(file?.sessionID).toBe("s-root");
      expect(file?.steps[0]?.source).toBe("wire");
      // the wrapper only takes over the chat endpoint; session header present
    } finally {
      globalThis.fetch = original;
    }
  });

  test("un step que termina 45 s después del request SIGUE contando (ventana anclada al fin del stream)", async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    const capture = createStatsCapture({ handoffDir: dir, now: () => clock });
    const original = globalThis.fetch;
    const encoder = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"id":"x","choices":[{"delta":{"content":"h"}}]}\n\n`,
              ),
            );
            await gate;
            controller.enqueue(
              encoder.encode(
                `data: {"id":"x","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":42,"total_tokens":43}}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      const response = await capture.wireFetch(
        wireRequest({ "x-session-id": "s-root" }),
        { method: "POST" },
      );
      const reader = response.body!.getReader();
      await reader.read(); // primer byte → primer chunk (t ≈ t0)
      clock += 45_000; // el stream sigue abierto 45 s después del request
      release();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      await settle(10); // finish() fija t2 = stream end (t0 + 45 s)
      // con la ventana anclada al REQUEST el pend habría caducado (30 s < 45 s)
      await capture.handleEvent(ASSISTANT_UPDATE({}, clock));
      const collector = capture.collectors.get("s-root");
      expect(collector?.summary().steps).toBe(1);
      expect(collector?.summary().tokensOutTotal).toBe(42);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("requests con header de sesión hija (x-parent-session-id) pasan sin medir", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(sseBody(10))) as unknown as typeof fetch;
    try {
      const response = await capture.wireFetch(
        wireRequest({
          "x-session-id": "sa-child",
          "x-parent-session-id": "s-root",
        }),
      );
      expect(response.ok).toBe(true);
      await settle(10);
      expect(capture.collectors.size).toBe(0); // subagentes: ni siquiera penden
    } finally {
      globalThis.fetch = original;
    }
  });

  test("no-chat URLs y calls sin session header pasan intocados (con degradación avisada una vez)", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return new Response(`hit:${url}`, { status: 200 });
    }) as unknown as typeof fetch;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const r1 = await capture.wireFetch("https://ollama.com/v1/models");
      expect(await r1.text()).toContain("hit:");
      const r2 = await capture.wireFetch(wireRequest()); // sin x-session-id
      expect(await r2.text()).toContain("hit:");
      // el seam cambió (chat sin x-session-id): el usuario recibe UN aviso
      expect(warnings.join(" ")).toContain("without x-session-id");
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = original;
    }
  });

  test("compaction y step real conviven: cada message.updated reclama SU pending", async () => {
    const dir = await tempDir();
    let clock = 2_000_000;
    const capture = createStatsCapture({ handoffDir: dir, now: () => clock });
    const original = globalThis.fetch;
    const responses = [sseResponse(sseBody(7)), sseResponse(sseBody(50))];
    globalThis.fetch = (async () =>
      responses.shift() ?? sseResponse(sseBody(1))) as unknown as typeof fetch;
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      // request A = la compaction (pend ts = T0)
      clock = 2_000_000;
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      });
      await settle();
      // el message.updated de la compaction reclama SU pending: se consume y
      // se rechaza por la regla de compaction — nunca llega al summary
      await capture.handleEvent(
        ASSISTANT_UPDATE(
          { agent: "compaction", mode: "compaction", summary: true },
          2_000_100,
        ),
      );
      expect(capture.collectors.get("s-root")?.summary().steps).toBe(0);
      // request B = el step real (pend ts = T1 > T0)
      clock = 2_010_000;
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      });
      await settle();
      await capture.handleEvent(ASSISTANT_UPDATE({}, 2_010_100));
      const collector = capture.collectors.get("s-root");
      expect(collector?.summary().steps).toBe(1);
      expect(collector?.summary().tokensOutTotal).toBe(50); // SOLO el step real
    } finally {
      globalThis.fetch = original;
    }
  });

  test("titlegen: sin mensaje asistente que reclame, el pend no llega al summary", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(sseBody(3))) as unknown as typeof fetch;
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      });
      // ningún message.updated llega (titlegen solo escribe el título):
      // el pend existó y caduca solo; el collector queda con 0 steps
      await settle(50);
      expect(capture.collectors.get("s-root")?.summary().steps).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("un stream con chunks pero sin usage chunk se descarta con UN aviso", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        `data: {"id":"x","choices":[{"delta":{"content":"h"}}]}\n\n`,
        `data: [DONE]\n\n`,
      ])) as unknown as typeof fetch;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      });
      await settle();
      expect(warnings.join(" ")).toContain("no usage chunk seen");
      // sin medición no hay collector: el step se descartó antes de pender
      expect(capture.collectors.get("s-root")?.summary().steps ?? 0).toBe(0);
      expect(capture.collectors.size).toBe(0);
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = original;
    }
  });

  test("statsDebug: el sink inyectado recibe una línea por intento de claim", async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    const capture = createStatsCapture({
      handoffDir: dir,
      debugSink: (line) => lines.push(line),
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(sseBody(120))) as unknown as typeof fetch;
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      });
      await settle();
      await capture.handleEvent(ASSISTANT_UPDATE());
      const claim = lines.find((l) => l.includes("result=accepted"));
      expect(claim).toBeDefined();
      expect(claim).toContain("session=s-root");
      expect(claim).toContain("agent=build");
      expect(claim).toContain("pendings=1");
      expect(claim).toContain("pends=["); // cada pend: ts/source
      // un mensaje sin pendings que reclamar también se registra
      await capture.handleEvent(ASSISTANT_UPDATE({ id: "m2" }));
      expect(lines.some((l) => l.includes("result=none"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("regresión misma sesión: la instantánea en disco con MÁS steps nunca se sobreescribe", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const original = globalThis.fetch;
    const fakeStep: StepMeasurement = {
      sessionID: "s-root",
      providerID: "ollama-cloud",
      modelID: "glm-5.3",
      ttftMs: 250,
      tokensOut: 90,
      decodeMs: 3_000,
      source: "wire",
      ts: Date.now(),
    };
    await capture.store.write({
      sessionID: "s-root",
      generatedAt: new Date().toISOString(),
      summary: {
        steps: 3,
        tokensOutTotal: 999,
        decodeMsTotal: 9_000,
        avgTps: 111,
        avgTtftMs: 250,
      },
      steps: [fakeStep, fakeStep, fakeStep],
    });
    globalThis.fetch = (async () =>
      sseResponse(sseBody(120))) as unknown as typeof fetch;
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT);
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      });
      await settle();
      await capture.handleEvent(ASSISTANT_UPDATE());
      // el estado de 1 step pierde contra el de 3 steps ya publicado
      const file = await capture.store.read("s-root");
      expect(file?.summary.steps).toBe(3);
      expect(file?.summary.tokensOutTotal).toBe(999);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("handoff v2 — un archivo por sesión (D3)", () => {
  test("write/read por sesión: dos sesiones coexisten y la ajena se rechaza", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const file = (sessionID: string) => ({
      sessionID,
      generatedAt: "2026-09-03T00:00:00.000Z",
      summary: {
        steps: 1,
        tokensOutTotal: 10,
        decodeMsTotal: 1_000,
        avgTps: 10,
        avgTtftMs: 200,
      },
      steps: [
        {
          sessionID,
          providerID: "ollama-cloud",
          modelID: "glm-5.3",
          ttftMs: 200,
          tokensOut: 10,
          decodeMs: 1_000,
          source: "wire" as const,
          ts: 1,
        },
      ],
    });
    await capture.store.write(file("s-a"));
    await capture.store.write(file("s-b"));
    expect((await capture.store.read("s-a"))?.sessionID).toBe("s-a");
    expect((await capture.store.read("s-b"))?.sessionID).toBe("s-b");
    // pathFor es por sesión y sanitiza el id: los caracteres fuera de
    // [A-Za-z0-9_-] se sustituyen, nada de traversal
    const p = capture.store.pathFor("../evil");
    expect(p.endsWith("stats-___evil.json")).toBe(true);
    expect(await capture.store.read("s-missing")).toBeNull();
  });

  test("cleanup borra el legacy stats.json y las sesiones ajenas, y cuenta lo borrado", async () => {
    const dir = await tempDir();
    const capture = createStatsCapture({ handoffDir: dir });
    const legacy = join(dir, "stats.json");
    await Bun.write(legacy, "{}");
    const other = capture.store.pathFor("s-old");
    await Bun.write(other, JSON.stringify({ sessionID: "s-old" }));
    const deleted = await capture.store.cleanup("s-keep", 24 * 60 * 60 * 1000);
    expect(deleted).toBeGreaterThanOrEqual(2); // legacy + s-old (+ basura del tmp si la hubiera)
    expect(await Bun.file(legacy).exists()).toBe(false);
    expect(await Bun.file(other).exists()).toBe(false);
    expect(await capture.store.read("s-old")).toBeNull();
  });
});
