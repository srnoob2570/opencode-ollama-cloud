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
  sessionModelID: "glm-5.3",
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

  test("subagent event route: session has parentID", () => {
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
      expect(isMainStep({ ...MAIN, message, sessionModelID: "glm-5.3" })).toBe(
        false,
      );
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

  test("modelID is a sanity check only (insufficient alone by design)", () => {
    // compaction inherits the model; excluded above. A non-compaction message
    // with a different model than the session choice drops out.
    expect(
      isMainStep({ ...MAIN, message: { ...MAIN.message, modelID: "kimi-k3" } }),
    ).toBe(false);
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
    sessionModelID: "glm-5.3",
  };

  test("attaches to the assistant message and passes the main-step gate", () => {
    const { claimed, rest } = claimPendingWire([{ ...pend, sessionID: "s1" }], {
      now: 2000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: {
        role: "assistant",
        agent: "build",
        modelID: "glm-5.3",
        providerID: "ollama-cloud",
      },
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
        message: {
          role: "assistant",
          agent: "build",
          modelID: "glm-5.3",
          providerID: "ollama-cloud",
        },
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
        message: {
          role: "assistant",
          agent: "build",
          modelID: "glm-5.3",
          providerID: "ollama-cloud",
        },
      },
    );
    expect(claimed).not.toBeNull();
    expect(rest).toHaveLength(1);
    expect(rest[0].sessionID).toBe("other");
  });
});

const makeCollector = () => ({ ...createStatsCollector("s1") });

describe("StatsCollector (in-memory, vivo, sin persistencia)", () => {
  test("ingesta directa con señales completas", () => {
    const c = makeCollector();
    c.ingest(step(), { ...MAIN });
    expect(c.summary().steps).toBe(1);
  });

  test("wire route: pend → claim promotes into steps", () => {
    const c = makeCollector();
    c.pend(
      { ttftMs: 250, tokensOut: 90, decodeMs: 3_000, source: "wire", ts: 5 },
      {
        sessionID: "s1",
        requestParentSessionId: null,
        sessionParentId: null,
        sessionModelID: "glm-5.3",
        now: 6,
      },
    );
    c.claim({
      now: 10,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: {
        role: "assistant",
        agent: "build",
        modelID: "glm-5.3",
        providerID: "ollama-cloud",
      },
    });
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
        sessionModelID: "glm-5.3",
        now: 6,
      },
    );
    c.claim({
      now: 10,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: { role: "assistant", agent: "build" },
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
        sessionModelID: "glm-5.3",
        now: 6,
      },
    );
    c.sweep(999_999);
    c.claim({
      now: 999_001,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: { role: "assistant", agent: "build" },
    });
    expect(c.summary().steps).toBe(0);
  });

  test("recent returns newest-first for the /stats dialog", () => {
    const c = makeCollector();
    const base = step({});
    c.ingest({ ...base, ts: base.ts + 2000 }, { ...MAIN });
    c.ingest({ ...base, ts: base.ts + 1000 }, { ...MAIN });
    const recent = c.recent(5);
    expect(recent).toHaveLength(2);
    expect(recent[0].ts).toBe(base.ts + 2000);
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

  test("single-chunk response is wire-nostream and counts total latency as decode", () => {
    const m = measurementFromWire({
      t0: 1000,
      t2: 1900,
      chunks: [{ t: 1900, usage: { completion_tokens: 8 } }],
      providerID: "ollama-cloud",
      modelID: "glm-5.3",
    });
    expect(m?.source).toBe("wire-nostream");
    expect(m?.ttftMs).toBe(900);
    expect(m?.decodeMs).toBe(900);
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
describe("claimPendingWire — contrato newest-wins", () => {
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
    sessionModelID: "glm-5.3",
    ...over,
  });

  test("dos pendings no reclamados (aborto + reintento): reclama el MÁS NUEVO", () => {
    const older = pend(1); // intento abortado
    const newer = pend(2); // reintento — el mensaje completado es el último
    const { claimed, rest } = claimPendingWire([older, newer], {
      now: 2_000,
      sessionID: "s1",
      session: { parentID: null, agent: "build" },
      message: {
        role: "assistant",
        agent: "build",
        modelID: "glm-5.3",
        providerID: "ollama-cloud",
      },
    });
    expect(claimed?.tokensOut).toBe(newer.measurement.tokensOut);
    expect(claimed?.ts).toBe(newer.measurement.ts);
    expect(rest.map((p) => p.measurement.ts)).toEqual([older.measurement.ts]);
  });
});
