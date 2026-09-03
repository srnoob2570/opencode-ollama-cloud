// Streaming stats pipeline (TTFT / TPS), pure by design: no fs, no timers, no
// network. This module is the single seam the stats effort tests through
// (approved in the implementation spec); the wire-fetch capture (capture.ts)
// and the TUI module both feed on it.
//
// Glossary (CONTEXT.md): a unit is an *LLM step* (each streaming completion);
// the *session average* is token-weighted TPS + simple-mean TTFT across
// main-thread steps only — no per-model breakdown, never persisted.

/**
 * Where a measurement came from. Only the wire route exists anymore (D2: the
 * event route was retired — stats measure ONLY ollama-cloud); `wire-nostream`
 * is purely a LABEL for single-chunk responses so the UI can tag "(direct)".
 */
export type MeasurementSource = "wire" | "wire-nostream";

/** One measured LLM step (spec §1.4). In-memory per session, never persisted. */
export interface StepMeasurement {
  sessionID: string;
  providerID: string;
  modelID: string;
  /** Request sent → first token. */
  ttftMs: number;
  /** Output tokens including reasoning (opencode's `tokens.output` semantics). */
  tokensOut: number;
  /** First token → stream end. */
  decodeMs: number;
  source: MeasurementSource;
  /** Wall-clock start of the request (ms since epoch). */
  ts: number;
}

/** Aggregates the live line and /stats dialog read. */
export interface SessionSummary {
  steps: number;
  tokensOutTotal: number;
  decodeMsTotal: number;
  /** Token-weighted: total output tokens over total decode time (tok/s). */
  avgTps: number;
  /** Simple mean per step (latency is a time, not a volume). */
  avgTtftMs: number;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Session average per the ratified contract: weighted TPS, simple-mean TTFT. */
export function summarize(steps: readonly StepMeasurement[]): SessionSummary {
  const tokensOutTotal = steps.reduce((a, s) => a + s.tokensOut, 0);
  const decodeMsTotal = steps.reduce((a, s) => a + s.decodeMs, 0);
  return {
    steps: steps.length,
    tokensOutTotal,
    decodeMsTotal,
    avgTps: decodeMsTotal === 0 ? 0 : tokensOutTotal / (decodeMsTotal / 1000),
    avgTtftMs: mean(steps.map((s) => s.ttftMs)),
  };
}

export interface SessionInfo {
  parentID?: string | null;
  /** The agent the session is currently driven by (session.Info.agent). */
  agent?: string | null;
}

export interface AssistantMessageInfo {
  role?: string | null;
  parentID?: string | null;
  agent?: string | null;
  mode?: string | null;
  summary?: boolean | null;
  modelID?: string | null;
  providerID?: string | null;
  sessionID?: string | null;
}

/**
 * Signals the capture routes must supply before a measurement may join the
 * session average — spec §1.3, all AND-combined (verified in opencode
 * source, see research/capacidades-opencode-ui-stats.md):
 *
 * 1. wire requests of child (subagent) sessions carry `x-parent-session-id`
 * 2. the main thread is the only session whose Session.Info has no `parentID`
 *    (assistant messages ALWAYS carry their message-level parentID — the user
 *    prompt — so it is not a discriminator)
 * 3. compaction may inherit the session model → excluded by
 *    agent/mode/summary, never by modelID
 * 4. the message's agent must be the session's active agent
 * 5. title generation leaves no assistant message → never correlates at all
 *
 * Subtask-part wrapper messages (agent = the task's agent in the parent
 * session) are excluded by rule 4 when the session's agent is known; when the
 * session agent had to be learned on the fly this edge stays open (spec risk
 * note) — the wrapper is a synthetic message and never owns a wire request.
 */
export interface MainStepSignals {
  requestParentSessionId?: string | null;
  session?: SessionInfo | null;
  message?: AssistantMessageInfo | null;
}

/** Rule 3 of the main-step gate: compaction can complete like a real step. */
export const isCompactionMessage = (message: AssistantMessageInfo): boolean =>
  message.agent === "compaction" ||
  message.mode === "compaction" ||
  message.summary === true;

export function isMainStep(signals: MainStepSignals): boolean {
  // 1. wire signal: subagent sessions always send x-parent-session-id
  if (signals.requestParentSessionId) return false;
  const session = signals.session;
  const message = signals.message;
  if (!session || !message) return false;
  // 2. the main thread is the only session without parentID
  if (session.parentID) return false;
  // role: assistant only
  if (message.role !== "assistant") return false;
  // 3. compaction is excluded explicitly (it can inherit the session model,
  //    so modelID can never be the primary filter here)
  if (isCompactionMessage(message)) return false;
  // 4. the driving agent must be the session's active agent (constant
  //    names are wrong — build/plan/custom agents exist)
  if (!message.agent || !session.agent || message.agent !== session.agent)
    return false;
  // (the modelID sanity-check was retired — spec decision 4 withdrawn: it
  // never discriminated anything since compaction inherits the session model)
  return true;
}

/** A wire measurement still pending correlation with an assistant message. */
export interface PendingWireStep {
  sessionID: string;
  measurement: Omit<StepMeasurement, "sessionID" | "providerID" | "modelID">;
  /** Milliseconds of wall-clock window the request may be attached within. */
  deadline: number;
  sessionParentId: string | null;
}

export const PENDING_WINDOW_MS = 30_000;
/** Same-clock server-side tolerance between message.time.created and the
 * request's ts when correlating by time (ratified claim contract). */
export const CLAIM_TOLERANCE_MS = 2_000;

/**
 * Attach a pending wire measurement to the assistant message that just
 * updated for its session. Correlation is TIME-based, not blind newest-wins:
 * among the session's unexpired pendings we take the one with the LARGEST ts
 * that still falls at/below the message's creation + 2 s — so an aborted old
 * attempt and a real retry each correlate to their own message instead of the
 * newest pending being stolen by whoever updates first. A message without a
 * usable time.created falls back to the legacy newest-wins pick. Whatever the
 * selection, the chosen pending is CONSUMED even when the main-step gate
 * rejects it (compaction attaches and is dropped — its measurement must never
 * leak into the next real step's claim); uncorrelated requests (titlegen)
 * expire and are swept.
 *
 * `now` injectable for tests.
 */
export function claimPendingWire(
  pending: readonly PendingWireStep[],
  input: {
    now: number;
    sessionID: string;
    session: SessionInfo | null;
    message: AssistantMessageInfo;
    /** message.time.created in ms; null when unknown → newest-wins fallback. */
    messageTimeCreated: number | null;
  },
): {
  claimed: StepMeasurement | null;
  /** The pending consumed by this attempt, even when the gate rejects it. */
  claimedPending: PendingWireStep | null;
  rest: PendingWireStep[];
} {
  const alive = (s: PendingWireStep): boolean =>
    s.sessionID === input.sessionID && s.deadline >= input.now;
  let claimedIndex = -1;
  if (input.messageTimeCreated == null) {
    // newest first: later insertions are later requests for this session
    for (let i = pending.length - 1; i >= 0; i--) {
      if (alive(pending[i])) {
        claimedIndex = i;
        break;
      }
    }
  } else {
    // largest ts still at/below the message creation (+ tolerance); ties go
    // to the later insertion (the later request for the same clock instant)
    const limit = input.messageTimeCreated + CLAIM_TOLERANCE_MS;
    let bestTs = -Infinity;
    for (let i = 0; i < pending.length; i++) {
      const step = pending[i];
      if (!alive(step)) continue;
      if (step.measurement.ts <= limit && step.measurement.ts >= bestTs) {
        bestTs = step.measurement.ts;
        claimedIndex = i;
      }
    }
  }
  const claimedPending = claimedIndex >= 0 ? pending[claimedIndex] : null;
  const restPending = pending.filter((_, i) => i !== claimedIndex);
  let claimed: StepMeasurement | null = null;
  if (claimedPending) {
    claimed = {
      ...claimedPending.measurement,
      sessionID: input.sessionID,
      providerID: input.message.providerID ?? "unknown",
      modelID: input.message.modelID ?? "unknown",
    };
    if (
      !isMainStep({
        requestParentSessionId: null,
        session: input.session,
        message: input.message,
      })
    )
      claimed = null;
  }
  return { claimed, claimedPending, rest: restPending };
}

/** What a claim attempt concluded, for the statsDebug instrumentation. */
export type ClaimResult =
  "accepted" | "rejected-compaction" | "rejected-gate" | "none";

export interface ClaimAttempt {
  /** Pendings the attempt could choose from (same session, unexpired). */
  pendings: Array<{ ts: number; source: MeasurementSource }>;
  result: ClaimResult;
}

/** Rolling, per-session store: source of truth for the live line and dialogs. */
export interface StatsCollector {
  /** Wire route: stash a request measurement until its assistant message shows up. */
  pend(
    measurement: Omit<StepMeasurement, "sessionID" | "providerID" | "modelID">,
    input: {
      sessionID: string;
      requestParentSessionId: string | null;
      sessionParentId: string | null;
      now: number;
    },
  ): void;
  /** Wire route: correlate an assistant message with a pending step. */
  claim(input: {
    now: number;
    sessionID: string;
    session: SessionInfo | null;
    message: AssistantMessageInfo;
    messageTimeCreated: number | null;
  }): ClaimAttempt;
  /** Drop stale pendings that no message ever claimed (titlegen). */
  sweep(now: number): void;
  summary(): SessionSummary;
  recent(count: number, now?: number): Array<StepMeasurement & { at: number }>;
}

/**
 * Cap on the in-memory step list: recent()/handoff never need deep history,
 * and a daemon-long session must not accumulate unbounded steps. summary()
 * reads RUNNING totals (kept on every insert), so trimming cannot change the
 * session average — summary stays EXACTLY summarize(all steps ever pushed).
 */
export const MAX_COLLECTOR_STEPS = 500;

export const createStatsCollector = (sessionID: string): StatsCollector => {
  const steps: StepMeasurement[] = [];
  let pending: PendingWireStep[] = [];
  let stepsCount = 0;
  let tokensOutTotal = 0;
  let decodeMsTotal = 0;
  let ttftMsSum = 0;

  const remember = (step: StepMeasurement): void => {
    steps.push(step);
    if (steps.length > MAX_COLLECTOR_STEPS) steps.shift(); // trimmed tail only
    stepsCount += 1;
    tokensOutTotal += step.tokensOut;
    decodeMsTotal += step.decodeMs;
    ttftMsSum += step.ttftMs;
  };

  return {
    pend(measurement, input) {
      // child sessions are excluded wire-side, before any correlation
      if (input.requestParentSessionId || input.sessionParentId) return;
      pending.push({
        sessionID,
        measurement: {
          ...measurement,
          ts: typeof measurement.ts === "number" ? measurement.ts : input.now,
        },
        deadline: input.now + PENDING_WINDOW_MS,
        sessionParentId: input.sessionParentId,
      });
    },
    claim(input) {
      // snapshot the candidate set first: it is what the instrumentation logs
      const pendings = pending
        .filter(
          (p) => p.sessionID === input.sessionID && p.deadline >= input.now,
        )
        .map((p) => ({ ts: p.measurement.ts, source: p.measurement.source }));
      const result = claimPendingWire(pending, input);
      pending = result.rest;
      let claimResult: ClaimResult = "none";
      if (result.claimedPending) {
        claimResult = result.claimed
          ? "accepted"
          : isCompactionMessage(input.message)
            ? "rejected-compaction"
            : "rejected-gate";
      }
      if (result.claimed) remember(result.claimed);
      return { pendings, result: claimResult };
    },
    sweep(now) {
      pending = pending.filter((p) => p.deadline >= now);
    },
    summary() {
      return {
        steps: stepsCount,
        tokensOutTotal,
        decodeMsTotal,
        avgTps:
          decodeMsTotal === 0 ? 0 : tokensOutTotal / (decodeMsTotal / 1000),
        avgTtftMs: stepsCount === 0 ? 0 : ttftMsSum / stepsCount,
      };
    },
    recent(count, now = Date.now()) {
      return [...steps]
        .sort((a, b) => a.ts - b.ts)
        .slice(-count)
        .reverse()
        .map((s) => ({ ...s, at: s.ts }));
    },
  };
};

// --- pure wire-SSE extraction -------------------------------------------------

/** One recorded wire chunk: arrival time + (for the final one) parsed usage. */
export interface RecordedChunk {
  t: number;
  usage?: { completion_tokens?: number; prompt_tokens?: number } | null;
}

/**
 * Turn recorded chunk timestamps into an LLM step measurement. TTFT = first
 * chunk arrival − request start (for a non-stream response this is the FULL
 * latency — correct per D1). decode = last → first chunk arrival, NEVER
 * t2 − t0: TPS must not penalize TTFT, so a step without real streaming gets
 * decodeMs ≈ 0 and thus weight 0 in the token-weighted session TPS. Tokens
 * come from the final usage chunk (opencode always requests include_usage —
 * see capacidades research); a step with no output tokens is not a step.
 * `t2` = stream end. Non-stream responses pass a single chunk and t2.
 */
export function measurementFromWire(input: {
  t0: number;
  chunks: readonly RecordedChunk[];
  t2: number;
  providerID: string;
  modelID: string;
}): StepMeasurement | null {
  const first = input.chunks[0];
  if (!first) return null;
  const usage = [...input.chunks].reverse().find((c) => c.usage != null)?.usage;
  const tokensOut = usage?.completion_tokens;
  const ttftMs = first.t - input.t0;
  const decodeMs = input.t2 - first.t;
  // label only — the UI tags single-chunk responses "(direct)"; it must NOT
  // change the math (D1: decode never stretches back to the request start)
  const noStream = input.chunks.length === 1 && input.t2 - first.t === 0;
  if (
    typeof tokensOut !== "number" ||
    !Number.isFinite(tokensOut) ||
    tokensOut <= 0
  )
    return null;
  return {
    sessionID: "",
    providerID: input.providerID,
    modelID: input.modelID,
    ttftMs: Math.max(0, ttftMs),
    tokensOut: tokensOut,
    decodeMs: Math.max(0, decodeMs),
    source: noStream ? "wire-nostream" : "wire",
    ts: input.t0,
  };
}
