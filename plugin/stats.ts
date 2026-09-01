// Streaming stats pipeline (TTFT / TPS), pure by design: no fs, no timers, no
// network. This module is the single seam the stats effort tests through
// (approved in the implementation spec); the capture routes (wire fetch wrap
// in index.ts, event correlation) and the TUI module both feed on it.
//
// Glossary (CONTEXT.md): a unit is an *LLM step* (each streaming completion);
// the *session average* is token-weighted TPS + simple-mean TTFT across
// main-thread steps only — no per-model breakdown, never persisted.

/** Where a measurement came from. `wire` beats `event` in precision. */
export type MeasurementSource = "wire" | "wire-nostream" | "event"

/** One measured LLM step (spec §1.4). In-memory per session, never persisted. */
export interface StepMeasurement {
  sessionID: string
  providerID: string
  modelID: string
  /** Request sent → first token. */
  ttftMs: number
  /** Output tokens including reasoning (opencode's `tokens.output` semantics). */
  tokensOut: number
  /** First token → stream end. */
  decodeMs: number
  source: MeasurementSource
  /** Wall-clock start of the request (ms since epoch). */
  ts: number
}

/** Aggregates the live line and /stats dialog read. */
export interface SessionSummary {
  steps: number
  tokensOutTotal: number
  decodeMsTotal: number
  /** Token-weighted: total output tokens over total decode time (tok/s). */
  avgTps: number
  /** Simple mean per step (latency is a time, not a volume). */
  avgTtftMs: number
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

/** Session average per the ratified contract: weighted TPS, simple-mean TTFT. */
export function summarize(steps: readonly StepMeasurement[]): SessionSummary {
  const tokensOutTotal = steps.reduce((a, s) => a + s.tokensOut, 0)
  const decodeMsTotal = steps.reduce((a, s) => a + s.decodeMs, 0)
  return {
    steps: steps.length,
    tokensOutTotal,
    decodeMsTotal,
    avgTps: decodeMsTotal === 0 ? 0 : tokensOutTotal / (decodeMsTotal / 1000),
    avgTtftMs: mean(steps.map((s) => s.ttftMs)),
  }
}

export interface SessionInfo {
  parentID?: string | null
  /** The agent the session is currently driven by (session.Info.agent). */
  agent?: string | null
}

export interface AssistantMessageInfo {
  role?: string | null
  parentID?: string | null
  agent?: string | null
  mode?: string | null
  summary?: boolean | null
  modelID?: string | null
  providerID?: string | null
  sessionID?: string | null
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
  requestParentSessionId?: string | null
  session?: SessionInfo | null
  message?: AssistantMessageInfo | null
  /** modelID the session is currently driven with — sanity check only. */
  sessionModelID?: string | null
}

export function isMainStep(signals: MainStepSignals): boolean {
  // 1. wire signal: subagent sessions always send x-parent-session-id
  if (signals.requestParentSessionId) return false
  const session = signals.session
  const message = signals.message
  if (!session || !message) return false
  // 2. the main thread is the only session without parentID
  if (session.parentID) return false
  // role: assistant only
  if (message.role !== "assistant") return false
  // 3. compaction is excluded explicitly (it can inherit the session model,
  //    so modelID can never be the primary filter here)
  if (message.agent === "compaction" || message.mode === "compaction") return false
  if (message.summary) return false
  // 4. the driving agent must match the session's active agent (constant
  //    names are wrong — build/plan/custom agents exist)
  if (!message.agent || !session.agent || message.agent !== session.agent) return false
  // sanity check only: same model as the session's choice (NOT sufficient
  // alone, compaction inherits it — hence the checks above)
  if (signals.sessionModelID && message.modelID && signals.sessionModelID !== message.modelID)
    return false
  return true
}

/** A wire measurement still pending correlation with an assistant message. */
export interface PendingWireStep {
  sessionID: string
  measurement: Omit<StepMeasurement, "sessionID" | "providerID" | "modelID">
  /** Milliseconds of wall-clock window the request may be attached within. */
  deadline: number
  sessionParentId: string | null
  sessionModelID: string | null
}

export const PENDING_WINDOW_MS = 30_000

/**
 * Attach a pending wire measurement to the assistant message that just
 * updated for its session. When several requests are unclaimed (an aborted
 * attempt followed by a retry), the NEWEST one wins — the message the server
 * just completed is the latest request by construction. Uncorrelated requests
 * (titlegen writes no message) expire and are dropped; compaction attaches
 * but is then rejected by isMainStep's compaction checks.
 *
 * `now` injectable for tests.
 */
export function claimPendingWire(
  pending: readonly PendingWireStep[],
  input: {
    now: number
    sessionID: string
    session: SessionInfo | null
    message: AssistantMessageInfo
  },
): { claimed: StepMeasurement | null; rest: PendingWireStep[] } {
  let claimedIndex = -1
  // newest first: later insertions are later requests for this session
  for (let i = pending.length - 1; i >= 0; i--) {
    const step = pending[i]
    if (claimedIndex === -1 && step.sessionID === input.sessionID && step.deadline >= input.now) {
      claimedIndex = i
      break
    }
  }
  const claimed = claimedIndex >= 0 ? pending[claimedIndex] : null
  const restPending = pending.filter((_, i) => i !== claimedIndex)
  let result: StepMeasurement | null = null
  if (claimed) {
    result = {
      ...claimed.measurement,
      sessionID: input.sessionID,
      providerID: input.message.providerID ?? "unknown",
      modelID: input.message.modelID ?? "unknown",
    }
    if (
      !isMainStep({
        requestParentSessionId: null,
        session: input.session,
        message: input.message,
      })
    )
      result = null
  }
  return { claimed: result, rest: restPending }
}

/** Rolling, per-session store: source of truth for the live line and dialogs. */
export interface StatsCollector {
  /** Event route: full signals known upfront, ingest directly. */
  ingest(measurement: StepMeasurement, signals: MainStepSignals): void
  /** Wire route: stash a request measurement until its assistant message shows up. */
  pend(measurement: Omit<StepMeasurement, "sessionID" | "providerID" | "modelID">, input: {
    sessionID: string
    requestParentSessionId: string | null
    sessionParentId: string | null
    sessionModelID: string | null
    now: number
  }): void
  /** Wire route: attach the newest unclaimed pending step for the session. */
  claim(input: {
    now: number
    sessionID: string
    session: SessionInfo | null
    message: AssistantMessageInfo
  }): void
  /** Drop stale pendings that no message ever claimed (titlegen). */
  sweep(now: number): void
  summary(): SessionSummary
  recent(count: number, now?: number): Array<StepMeasurement & { at: number }>
}

export const createStatsCollector = (sessionID: string): StatsCollector => {
  const steps: StepMeasurement[] = []
  let pending: PendingWireStep[] = []

  return {
    ingest(measurement, signals) {
      if (isMainStep(signals)) steps.push({ ...measurement, sessionID })
    },
    pend(measurement, input) {
      // child sessions are excluded wire-side, before any correlation
      if (input.requestParentSessionId || input.sessionParentId) return
      pending.push({
        sessionID,
        measurement: { ...measurement, ts: typeof measurement.ts === "number" ? measurement.ts : input.now },
        deadline: input.now + PENDING_WINDOW_MS,
        sessionParentId: input.sessionParentId,
        sessionModelID: input.sessionModelID,
      })
    },
    claim(input) {
      const result = claimPendingWire(pending, input)
      pending = result.rest
      if (result.claimed) steps.push(result.claimed)
    },
    sweep(now) {
      pending = pending.filter((p) => p.deadline >= now)
    },
    summary() {
      return summarize(steps)
    },
    recent(count, now = Date.now()) {
      return [...steps]
        .sort((a, b) => a.ts - b.ts)
        .slice(-count)
        .reverse()
        .map((s) => ({ ...s, at: s.ts }))
    },
  }
}

// --- pure wire-SSE extraction -------------------------------------------------

/** One recorded wire chunk: arrival time + (for the final one) parsed usage. */
export interface RecordedChunk {
  t: number
  usage?: { completion_tokens?: number; prompt_tokens?: number } | null
}

/**
 * Turn recorded chunk timestamps into an LLM step measurement. TTFT = first
 * chunk arrival; decode = last → first; tokens from the final usage chunk
 * (opencode always requests include_usage — see capacidades research).
 * `t2` = stream end. Non-stream responses pass a single chunk and t2.
 */
export function measurementFromWire(input: {
  t0: number
  chunks: readonly RecordedChunk[]
  t2: number
  providerID: string
  modelID: string
}): StepMeasurement | null {
  const first = input.chunks[0]
  if (!first) return null
  const usage = [...input.chunks].reverse().find((c) => c.usage != null)?.usage
  const tokensOut = usage?.completion_tokens
  const ttftMs = first.t - input.t0
  const decodeMs = input.t2 - first.t
  const fallbackDecodeMs = input.t2 - input.t0
  const noStream = input.chunks.length === 1 && input.t2 - first.t === 0
  if (typeof tokensOut !== "number" || !Number.isFinite(tokensOut) || tokensOut < 0) return null
  return {
    sessionID: "",
    providerID: input.providerID,
    modelID: input.modelID,
    ttftMs: Math.max(0, ttftMs),
    tokensOut: tokensOut,
    decodeMs: Math.max(0, noStream ? fallbackDecodeMs : decodeMs),
    source: noStream ? "wire-nostream" : "wire",
    ts: input.t0,
  }
}