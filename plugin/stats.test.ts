import { describe, expect, test } from "bun:test";
import {
  claimPendingWire,
  createStatsCollector,
  isMainStep,
  measurementFromWire,
  summarize,
  type StepMeasurement,
} from "./stats.ts";

// Fixture-shaped helper (mirrors test-fixtures.ts style: one factory per side
// of the contract).
const step = (overrides: Partial<StepMeasurement> = {}): StepMeasurement => ({
  sessionID: "s1",
  providerID: "ollama-cloud",
  modelID: "glm-5.3",
  ttftMs: 400,
  tokensOut: 300,
  decodeMs: 10_000,
  source: "wire",
  ts: 1_790_000_000_000,
  ...overrides,
});

const MAIN: Parameters<typeof isMainStep>[0] = {
  requestParentSessionId: null,
  session: { parentID: null, agent: "build" },
  // real assistant messages always carry their message-level parentID (the
  // user prompt) — it is NOT a subagent signal
  message: {
    role: "assistant",
    parentID: "um1",
    agent: "build",
    mode: null,
    summary: null,
    modelID: "glm-5.3",
  },
};

describe("summarize (promedio de sesión)", () => {
  test("weighted TPS: total tokens over total decode time, TTFT simple mean", () => {
    const s = summarize([
      step({ tokensOut: 600, decodeMs: 10_000, ttftMs: 400 }),
      step({ tokensOut: 300, decodeMs: 10_000, ttftMs: 200 }),
    ]);
    expect(s.tokensOutTotal).toBe(900);
    expect(s.decodeMsTotal).toBe(20_000);
    expect(s.avgTps).toBeCloseTo(45); // 900 / 20s
    expect(s.avgTtftMs).toBe(300); // simple mean, not weighted
  });

  test("short steps do not distort the weighted average (tool-loop steps)", () => {
    const s = summarize([
      step({ tokensOut: 1000, decodeMs: 20_000 }),
      step({ tokensOut: 2, decodeMs: 1_000 }),
    ]);
    expect(s.avgTps).toBeCloseTo(1002 / 21, 2); // 1002 tokens / 21 s, not ((50 + 2) / 2)
  });

  test("empty session has zero shape without NaN", () => {
    expect(summarize([])).toEqual({
      steps: 0,
      tokensOutTotal: 0,
      decodeMsTotal: 0,
      avgTps: 0,
      avgTtftMs: 0,
    });
  });

  test("D1: a zero-decode step adds tokens but zero weight to the TPS", () => {
    // non-stream step: decodeMs 0 contributes 0 to decodeMsTotal → its tokens
    // ride along but never distort the tok/s; TTFT keeps the full latency
    const s = summarize([
      step({ tokensOut: 600, decodeMs: 10_000, ttftMs: 400 }),
      step({ tokensOut: 8, decodeMs: 0, ttftMs: 900, source: "wire-nostream" }),
    ]);
    expect(s.decodeMsTotal).toBe(10_000);
    // 608 tokens over the SAME 10 s — the zero-decode step adds tokens but no
    // decode time, so the weighted TPS barely moves instead of being diluted
    expect(s.avgTps).toBeCloseTo(60.8);
    expect(s.avgTtftMs).toBeCloseTo(650); // simple mean over both steps
    expect(s.steps).toBe(2);
  });
});

describe("isMainStep (regla del chat principal, spec §1.3)", () => {
  test("main-thread assistant step passes all five signals", () => {
    expect(isMainStep(MAIN)).toBe(true);
  });

  test("subagent wire request: child sessions always send x-parent-session-id", () => {
    expect(
      isMainStep({ ...MAIN, requestParentSessionId: "root-session" }),
    ).toBe(false);
  });

  test("subagent session: session has parentID", () => {
    expect(
      isMainStep({ ...MAIN, session: { ...MAIN.session, parentID: "root" } }),
    ).toBe(false);
  });

  test("compaction is excluded by agent/mode/summary even when it inherits the session model", () => {
    for (const message of [
      { ...MAIN.message, agent: "compaction" },
      { ...MAIN.message, mode: "compaction", agent: "build" },
      { ...MAIN.message, summary: true },
      {
        ...MAIN.message,
        mode: "compaction",
        agent: "compaction",
        summary: true,
      },
    ])
      expect(isMainStep({ ...MAIN, message })).toBe(false);
  });

  test("agent of the message must be the session's active agent (no constants)", () => {
    expect(
      isMainStep({ ...MAIN, message: { ...MAIN.message, agent: "plan" } }),
    ).toBe(false);
    expect(
      isMainStep({ ...MAIN, message: { ...MAIN.message, agent: null } }),
    ).toBe(false);
    expect(
      isMainStep({ ...MAIN, session: { parentID: null, agent: null } }),
    ).toBe(false);
  });

  test("task-part wrapper message agents differently (agent ≠ session active agent)", () => {
    // the wrapper lives in the parent session with the task's agent; the
    // main-thread signal is the session's agent equality, not message.parentID
    // (every assistant message has one)
    expect(
      isMainStep({ ...MAIN, message: { ...MAIN.message, agent: "task" } }),
    ).toBe(false);
    expect(
      isMainStep({
        ...MAIN,
        message: { ...MAIN.message, parentID: "other-msg" },
      }),
    ).toBe(true);
  });

  test("modelID is NOT a filter anymore (sanity-check retired, spec decision 4 withdrawn)", () => {
    // a different model than the session's choice counts: compaction inherits
    // the model, so this check never discriminated anything real
    expect(
      isMainStep({ ...MAIN, message: { ...MAIN.message, modelID: "kimi-k3" } }),
    ).toBe(true);
  });

  test("non-assistant roles never count", () => {
    expect(
      isMainStep({ ...MAIN, message: { ...MAIN.message, role: "user" } }),
    ).toBe(false);
  });

  test("missing signals (no correlated session or message) never count", () => {
    expect(isMainStep({ ...MAIN, session: null })).toBe(false);
    expect(isMainStep({ ...MAIN, message: null })).toBe(false);
  });
});

describe("claimPendingWire (titlegen se descarta por no correlacionar)", () => {
  const pend = {
    sessionID: "s1",
    measurement: {
      ttftMs: 300,
      tokensOut: 120,
      decodeMs: 4_000,
      source: "wire" as const,
      ts: 1000,
    },
    deadline: 31_000,
    sessionParentId: null,
  };

  const message = {
    role: "assistant" as const,
    agent: "build",
    modelID: "glm-5.3",
    providerID: "ollama-cloud",
  };

  test("attaches to the assistant message and passes the main-step gate", () => {
    const { claimed, rest } = claimPendingWire([{ ...pend, sessionID: "s1" }], {
      now: 2000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: 1500,
    });
    expect(claimed?.ttftMs).toBe(300);
    expect(claimed?.modelID).toBe("glm-5.3");
    expect(rest).toEqual([]);
  });

  test("expired pendings (no message ever claims them = titlegen) are dropped by the window", () => {
    const { claimed } = claimPendingWire(
      [{ ...pend, sessionID: "s1", deadline: 31_000 }],
      {
        now: 40_000,
        sessionID: "s1",
        session: { parentID: null, agent: "build" },
        message,
        messageTimeCreated: 1500,
      },
    );
    expect(claimed).toBeNull();
  });

  test("other sessions' pendings stay untouched", () => {
    const keep = { ...pend, sessionID: "other" };
    const { claimed, rest } = claimPendingWire(
      [{ ...pend, sessionID: "s1" }, keep],
      {
        now: 2000,
        sessionID: "s1",
        session: { parentID: null, agent: "build" },
        message,
        messageTimeCreated: 1500,
      },
    );
    expect(claimed).not.toBeNull();
    expect(rest).toHaveLength(1);
    expect(rest[0].sessionID).toBe("other");
  });
});

const makeCollector = () => ({ ...createStatsCollector("s1") });

const MAIN_MESSAGE = {
  role: "assistant" as const,
  agent: "build",
  modelID: "glm-5.3",
  providerID: "ollama-cloud",
};

describe("StatsCollector (in-memory, vivo, sin persistencia)", () => {
  test("wire route: pend → claim promotes into steps", () => {
    const c = makeCollector();
    c.pend(
      { ttftMs: 250, tokensOut: 90, decodeMs: 3_000, source: "wire", ts: 5 },
      {
        sessionID: "s1",
        requestParentSessionId: null,
        sessionParentId: null,
        now: 6,
      },
    );
    const attempt = c.claim({
      now: 10,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: MAIN_MESSAGE,
      messageTimeCreated: 8,
    });
    expect(attempt.result).toBe("accepted");
    expect(c.summary().steps).toBe(1);
    expect(c.summary().tokensOutTotal).toBe(90);
  });

  test("wire route: child sessions never pend (subagentes fuera, antes de correlacionar)", () => {
    const c = makeCollector();
    c.pend(
      { ttftMs: 250, tokensOut: 90, decodeMs: 3_000, source: "wire", ts: 6 },
      {
        sessionID: "s1",
        requestParentSessionId: "root",
        sessionParentId: null,
        now: 6,
      },
    );
    c.claim({
      now: 10,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: MAIN_MESSAGE,
      messageTimeCreated: 8,
    });
    expect(c.summary().steps).toBe(0);
  });

  test("sweep drops stale pendings (titlegen never claims them)", () => {
    const c = makeCollector();
    c.pend(
      { ttftMs: 250, tokensOut: 12, decodeMs: 500, source: "wire", ts: 6 },
      {
        sessionID: "s1",
        requestParentSessionId: null,
        sessionParentId: null,
        now: 6,
      },
    );
    c.sweep(999_999);
    c.claim({
      now: 999_001,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: MAIN_MESSAGE,
      messageTimeCreated: 998_000,
    });
    expect(c.summary().steps).toBe(0);
  });

  test("recent returns newest-first for the /stats dialog", () => {
    const c = makeCollector();
    // two claims with different ts (pend → claim exercises the wire path)
    const pendStep = (ts: number, tokens: number) => {
      c.pend(
        {
          ttftMs: 250,
          tokensOut: tokens,
          decodeMs: 3_000,
          source: "wire",
          ts,
        },
        {
          sessionID: "s1",
          requestParentSessionId: null,
          sessionParentId: null,
          now: ts,
        },
      );
      c.claim({
        now: ts + 5_000,
        sessionID: "s1",
        session: { parentID: null, agent: "build" },
        message: MAIN_MESSAGE,
        messageTimeCreated: ts + 1_000,
      });
    };
    pendStep(1_790_000_000_000 + 1000, 10);
    pendStep(1_790_000_000_000 + 2000, 20);
    const recent = c.recent(5);
    expect(recent).toHaveLength(2);
    expect(recent[0].ts).toBe(1_790_000_000_000 + 2000);
  });
});

describe("resumen con totales corridos (>500 steps)", () => {
  test("summary() === summarize(sobre TODOS los steps jamás insertados)", () => {
    const c = makeCollector();
    const all: StepMeasurement[] = [];
    for (let i = 0; i < 600; i++) {
      const now = 10_000 + i * 100;
      c.pend(
        {
          ttftMs: 200 + (i % 7) * 10,
          tokensOut: 50 + i,
          decodeMs: 4_000 + i,
          source: i % 9 === 0 ? "wire-nostream" : "wire",
          ts: now,
        },
        {
          sessionID: "s1",
          requestParentSessionId: null,
          sessionParentId: null,
          now,
        },
      );
      c.claim({
        now: now + 90,
        sessionID: "s1",
        session: { parentID: null, agent: "build" },
        message: MAIN_MESSAGE,
        messageTimeCreated: now + 50,
      });
      all.push({
        sessionID: "s1",
        providerID: "ollama-cloud",
        modelID: MAIN_MESSAGE.modelID,
        ttftMs: 200 + (i % 7) * 10,
        tokensOut: 50 + i,
        decodeMs: 4_000 + i,
        source: i % 9 === 0 ? "wire-nostream" : "wire",
        ts: now,
      });
    }
    // capped in-memory list, exact running totals
    expect(c.summary()).toEqual(summarize(all));
    expect(c.recent(1000).length).toBeLessThanOrEqual(500);
  });
});

describe("measurementFromWire (extracción pura del stream)", () => {
  test("TTFT from first chunk, tokens from the final usage chunk", () => {
    const m = measurementFromWire({
      t0: 100,
      t2: 5200,
      chunks: [
        { t: 480 },
        { t: 600 },
        { t: 5100, usage: { completion_tokens: 120, prompt_tokens: 68 } },
      ],
      providerID: "ollama-cloud",
      modelID: "glm-5.3",
    });
    expect(m?.ttftMs).toBe(380);
    expect(m?.decodeMs).toBe(4720); // 5100 − 480 (final chunk − first chunk)
    expect(m?.tokensOut).toBe(120);
    expect(m?.source).toBe("wire");
  });

  test("D1: single-chunk response is wire-nostream, decode ≈ 0 and TTFT is the full latency", () => {
    const m = measurementFromWire({
      t0: 1000,
      t2: 1900,
      chunks: [{ t: 1900, usage: { completion_tokens: 8 } }],
      providerID: "ollama-cloud",
      modelID: "glm-5.3",
    });
    expect(m?.source).toBe("wire-nostream");
    expect(m?.ttftMs).toBe(900); // request → (only) token = full latency
    expect(m?.decodeMs).toBe(0); // t2 − first.t ≈ 0 — TPS never penalizes TTFT
  });

  test("zero output tokens → no step (unifica la regla con la ruta retirada)", () => {
    expect(
      measurementFromWire({
        t0: 0,
        t2: 100,
        chunks: [{ t: 50, usage: { completion_tokens: 0 } }],
        providerID: "p",
        modelID: "m",
      }),
    ).toBeNull();
  });

  test("no usage anywhere → no measurement (tokens unknown, never guessed)", () => {
    expect(
      measurementFromWire({
        t0: 0,
        t2: 100,
        chunks: [{ t: 50 }],
        providerID: "p",
        modelID: "m",
      }),
    ).toBeNull();
  });
});

describe("claimPendingWire — correlación por tiempo (tolerancia 2 s)", () => {
  const pend = (ts: number, over: Record<string, unknown> = {}) => ({
    sessionID: "s1",
    measurement: {
      ttftMs: 300 + ts,
      tokensOut: 100 + ts,
      decodeMs: 4_000,
      source: "wire" as const,
      ts,
    },
    deadline: Number.MAX_SAFE_INTEGER,
    sessionParentId: null as string | null,
    ...over,
  });
  const message = {
    role: "assistant" as const,
    agent: "build",
    modelID: "glm-5.3",
    providerID: "ollama-cloud",
  };

  test("messageTimeCreated null → fallback newest-wins (contrato legacy)", () => {
    const older = pend(1); // intento abortado
    const newer = pend(2); // reintento — el mensaje completado es el último
    const { claimed, rest } = claimPendingWire([older, newer], {
      now: 2_000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: null,
    });
    expect(claimed?.tokensOut).toBe(newer.measurement.tokensOut);
    expect(claimed?.ts).toBe(newer.measurement.ts);
    expect(rest.map((p) => p.measurement.ts)).toEqual([older.measurement.ts]);
  });

  test("a: dos pendings (abortado viejo + real nuevo) correlacionan cada uno con SU mensaje", () => {
    const aborted = pend(1_000); // intento abortado, stream acabó a los 1 s
    const real = pend(5_000); // reintento real
    // el mensaje del intento abortado (time.created ≈ su request) NO puede
    // robar el pending del reintento: su ventana de tolerancia termina en 3.1 s
    const first = claimPendingWire([aborted, real], {
      now: 6_000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: 1_100,
    });
    expect(first.claimed?.ts).toBe(aborted.measurement.ts);
    expect(first.rest.map((p) => p.measurement.ts)).toEqual([
      real.measurement.ts,
    ]);
    // el mensaje real llega después y reclama el SUYO
    const second = claimPendingWire(first.rest, {
      now: 6_500,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: 5_100,
    });
    expect(second.claimed?.ts).toBe(real.measurement.ts);
    expect(second.rest).toEqual([]);
  });

  test("a2: el mensaje nuevo NUNCA reclama el pending abortado viejo si el real está dentro de tolerancia", () => {
    const aborted = pend(1_000);
    const real = pend(5_000);
    const { claimed, rest } = claimPendingWire([aborted, real], {
      now: 6_000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: 5_100, // límite 7.1 s: ambos caben, gana el ts MAYOR
    });
    expect(claimed?.ts).toBe(real.measurement.ts);
    expect(rest.map((p) => p.measurement.ts)).toEqual([aborted.measurement.ts]);
  });

  test("b: compaction y step real conviven — cada message.updated reclama el suyo", () => {
    const compactionReq = pend(1_000); // el request wire de la compaction
    const realReq = pend(5_000); // el request del step real
    // 1) el message.updated de la compaction reclama SU pending y lo rechaza
    //    (isMainStep) — el pending se consume y desaparece
    const compactionClaim = claimPendingWire([compactionReq, realReq], {
      now: 6_000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: { ...message, agent: "compaction", mode: "compaction" },
      messageTimeCreated: 1_100,
    });
    expect(compactionClaim.claimed).toBeNull(); // rechazada por la regla
    expect(compactionClaim.claimedPending?.measurement.ts).toBe(1_000);
    expect(compactionClaim.rest.map((p) => p.measurement.ts)).toEqual([5_000]);
    // 2) el step real reclama SU pending y pasa la regla
    const realClaim = claimPendingWire(compactionClaim.rest, {
      now: 6_500,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: 5_100,
    });
    expect(realClaim.claimed?.ts).toBe(5_000);
    expect(realClaim.rest).toEqual([]);
  });

  test("ningún pending dentro de la tolerancia → no claim (no newest-wins ciego)", () => {
    // el message.updated pertenece a un mensaje ANTERIOR (mtc=1000) que llega
    // tarde: el pend del request en vuelo (ts=5000) queda FUERA de su ventana
    // (ts > mtc + 2 s) y no se lo puede llevar
    const inflight = pend(5_000);
    const { claimed, claimedPending, rest } = claimPendingWire([inflight], {
      now: 6_000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message,
      messageTimeCreated: 1_000,
    });
    expect(claimed).toBeNull();
    expect(claimedPending).toBeNull();
    expect(rest).toHaveLength(1); // ni siquiera se consume
  });

  test("rejection by the main-step gate still CONSUMES the pending (compaction se come el suyo)", () => {
    const compactionReq = pend(1_000);
    const { claimed, claimedPending, rest } = claimPendingWire(
      [compactionReq],
      {
        now: 2_000,
        sessionID: "s1",
        session: { parentID: null, agent: "build" },
        message: { ...message, agent: "compaction" },
        messageTimeCreated: 1_100,
      },
    );
    expect(claimed).toBeNull();
    expect(claimedPending).not.toBeNull();
    expect(rest).toEqual([]);
  });
});
