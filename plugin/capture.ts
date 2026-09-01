// Server side of the stats capture (spec Pieza 1): wire-accurate measurement
// for ollama-cloud via a fetch wrapper, event-derived measurement for any
// provider, and the per-session in-memory store that feeds the handoff.
// Everything here is defensive: the plugin must never break a session over
// stats. Verified opencode surfaces (fetch seam, event payloads, header
// signals) are documented in research/capacidades-opencode-ui-stats.md.
import type { RecordedChunk, StepMeasurement } from "./stats.ts";
import {
  createStatsCollector,
  measurementFromWire,
  type StatsCollector,
} from "./stats.ts";
import {
  createHandoffStore,
  MAX_HANDOFF_STEPS,
  type HandoffStore,
} from "./handoff.ts";

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const PARENT_SESSION_HEADER = "x-parent-session-id";
const SESSION_HEADER = "x-session-id";

/** Read a possibly-untyped runtime field (the SDK typings lag opencode's schema). */
const readStringField = (value: object, key: string): string | null => {
  const raw: unknown = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

/** fetch-assignable shape (Bun's typeof fetch adds preconnect). */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface StatsCapture {
  /** Drop-in fetch for the provider options. Chains over `next` — a
   * user-configured fetch (proxy/CA/agent) — delegating to it, or to the
   * global fetch when none exists. */
  wireFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    next?: FetchLike,
  ) => Promise<Response>;
  /** Server event hook body (never throws). */
  handleEvent(event: unknown): Promise<void>;
  store: HandoffStore;
}

const toAssistantMessageInfo = (
  message: Record<string, unknown>,
  sessionID: string,
) => ({
  role: "assistant" as const,
  parentID:
    typeof message.parentID === "string" && message.parentID.length > 0
      ? message.parentID
      : null,
  agent: readStringField(message, "agent"),
  mode: readStringField(message, "mode"),
  summary: typeof message.summary === "boolean" ? message.summary : null,
  modelID: typeof message.modelID === "string" ? message.modelID : null,
  providerID:
    typeof message.providerID === "string" ? message.providerID : null,
  sessionID,
});

const headerOf = (
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  name: string,
): string | null => {
  if (typeof init?.headers === "object" && init.headers !== null) {
    if (init.headers instanceof Headers) return init.headers.get(name);
    const value = (init.headers as Record<string, unknown>)[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (input instanceof Request) return input.headers.get(name);
  return null;
};

export const createStatsCapture = (
  input: { now?: () => number; handoffDir?: string } = {},
) => {
  const now = input.now ?? (() => Date.now());
  const store = createHandoffStore(input.handoffDir);
  const collectors = new Map<string, StatsCollector>();
  const sessions = new Map<
    string,
    { parentId: string | null; agent: string | null }
  >();
  // event route (other providers): arrival time of the first part update
  const firstPart = new Map<string, number>();
  // daemon-long maps need bounds: evict oldest on overflow (stats are
  // best-effort instrumentation, never allowed to leak memory)
  const MAX_Sessions = 500;
  const MAX_FIRST_PART = 1000;

  const rememberSession = (
    id: string,
    entry: { parentId: string | null; agent: string | null },
  ) => {
    sessions.delete(id); // re-insert to keep insertion order fresh
    sessions.set(id, entry);
    while (sessions.size > MAX_Sessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  };

  const rememberFirstPart = (messageID: string, at: number) => {
    firstPart.delete(messageID);
    firstPart.set(messageID, at);
    while (firstPart.size > MAX_FIRST_PART) {
      const oldest = firstPart.keys().next();
      if (oldest.done) break;
      firstPart.delete(oldest.value);
    }
  };

  const collectorFor = (sessionID: string): StatsCollector => {
    let collector = collectors.get(sessionID);
    if (!collector) {
      collector = createStatsCollector(sessionID);
      collectors.set(sessionID, collector);
    }
    return collector;
  };

  // Handoff write policy (deterministic, race-free): steps only grow within a
  // session, so a persist NEVER publishes fewer steps than what is already on
  // disk for the same session — an older state racing a newer one simply
  // loses. Identical snapshots skip the write outright.
  const persistedFingerprint = new Map<string, string>();

  const persist = async (sessionID: string): Promise<void> => {
    const collector = collectors.get(sessionID);
    if (!collector) return;
    const summary = collector.summary();
    const fingerprint = `${summary.steps}:${summary.tokensOutTotal}:${summary.decodeMsTotal}`;
    if (persistedFingerprint.get(sessionID) === fingerprint) return;
    const current = await store.read();
    if (
      current &&
      current.sessionID === sessionID &&
      current.summary.steps > summary.steps
    ) {
      persistedFingerprint.set(sessionID, fingerprint);
      return;
    }
    await store.write({
      sessionID,
      generatedAt: new Date(now()).toISOString(),
      summary,
      steps: collector.recent(MAX_HANDOFF_STEPS),
    });
    persistedFingerprint.set(sessionID, fingerprint);
  };

  const handleEvent = async (event: unknown): Promise<void> => {
    try {
      if (typeof event !== "object" || event === null) return;
      const type = readStringField(event, "type");
      const props = (event as Record<string, unknown>).properties;
      if (typeof props !== "object" || props === null) return;

      // events' Session.Info carries parentID (subagent sessions have one)
      if (type === "session.created" || type === "session.updated") {
        const info = (props as Record<string, unknown>).info;
        if (typeof info !== "object" || info === null) return;
        const id =
          typeof (info as Record<string, unknown>).id === "string"
            ? ((info as Record<string, unknown>).id as string)
            : null;
        if (!id) return;
        const previous = sessions.get(id);
        rememberSession(id, {
          parentId: readStringField(info, "parentID"),
          agent: previous?.agent ?? null,
        });
        return;
      }

      // idle = the turn settled: drop pendings that no message ever claimed
      // (titlegen) and cap the bounded maps
      if (type === "session.idle") {
        const id = readStringField(props, "sessionID");
        if (!id) return;
        collectors.get(id)?.sweep(now());
        return;
      }

      // first part-update marks TTFT candidate for the event route (payload:
      // { sessionID, part, time } — part carries its own messageID/time)
      if (type === "message.part.updated") {
        const record = props as Record<string, unknown>;
        const part = record.part as Record<string, unknown> | null;
        const messageID =
          part && typeof part === "object"
            ? (readStringField(part, "messageID") ??
              readStringField(part, "id"))
            : null;
        if (!messageID || firstPart.has(messageID)) return;
        const partTime = (part as { time?: { start?: unknown } } | undefined)
          ?.time?.start;
        const at = [record.time, partTime].find(
          (v): v is number => typeof v === "number" && v > 0,
        );
        if (at != null) rememberFirstPart(messageID, at);
        return;
      }

      if (type !== "message.updated") return;
      const info = (props as Record<string, unknown>).info;
      if (typeof info !== "object" || info === null) return;
      const message = info as Record<string, unknown>;
      if (message.role !== "assistant") return;
      const sessionID =
        typeof message.sessionID === "string" ? message.sessionID : null;
      if (!sessionID) return;

      const sessionInfo = sessions.get(sessionID);
      // subagent sessions are off the frontier entirely: no collector, no
      // claim, no persist (their message events must never clobber the
      // main session's handoff)
      if (sessionInfo?.parentId) return;

      const messageInfo = toAssistantMessageInfo(message, sessionID);
      // compaction inherits the session model and completes like a real step —
      // it must neither claim a pending wire measurement nor touch the handoff
      const isCompaction =
        messageInfo.agent === "compaction" ||
        messageInfo.mode === "compaction" ||
        messageInfo.summary === true;
      if (isCompaction) return;

      // the session's active agent: the first non-compaction assistant message
      // defines it (no constants — build/plan/custom agents exist)
      if (sessionInfo && sessionInfo.agent == null && messageInfo.agent) {
        rememberSession(sessionID, {
          ...sessionInfo,
          agent: messageInfo.agent,
        });
      }

      // --- event route (any provider), spec §1.2 ---------------------------
      if (message.providerID !== "ollama-cloud") {
        await ingestEventStep(sessionID, message);
        return;
      }

      // --- wire correlation: newest unclaimed pending claim wins ------------
      collectorFor(sessionID).claim({
        now: now(),
        sessionID,
        session: {
          parentID: sessionInfo?.parentId ?? null,
          agent: sessionInfo?.agent ?? messageInfo.agent,
        },
        message: messageInfo,
      });
      await persist(sessionID);
    } catch (error) {
      console.warn(
        "[opencode-ollama-cloud] stats capture ignored an event error:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  // spec §1.2: TTFT ≈ first part.updated − time.created; TPS ≈ output tokens
  // over completed − first part. tokens.output ≤ 0 means nothing was decoded
  // (titlegen et al. produce no assistant message here at all).
  const ingestEventStep = async (
    sessionID: string,
    message: Record<string, unknown>,
  ): Promise<void> => {
    const messageID = readStringField(message, "id");
    if (!messageID) return;
    const time = message.time as
      { created?: unknown; completed?: unknown } | undefined;
    const created = typeof time?.created === "number" ? time.created : null;
    const completed =
      typeof time?.completed === "number" ? time.completed : null;
    const firstPartTime = firstPart.get(messageID);
    const tokens = message.tokens as { output?: unknown } | undefined;
    const tokensOut =
      typeof tokens?.output === "number" && tokens.output > 0
        ? tokens.output
        : null;
    if (
      created == null ||
      completed == null ||
      firstPartTime == null ||
      tokensOut == null
    )
      return;
    firstPart.delete(messageID);
    const measurement: StepMeasurement = {
      sessionID,
      providerID: readStringField(message, "providerID") ?? "unknown",
      modelID: readStringField(message, "modelID") ?? "unknown",
      ttftMs: Math.max(0, firstPartTime - created),
      tokensOut,
      decodeMs: Math.max(0, completed - firstPartTime),
      source: "event",
      ts: created,
    };
    collectorFor(sessionID).ingest(measurement, {
      requestParentSessionId: null,
      session: {
        parentID: sessions.get(sessionID)?.parentId ?? null,
        agent:
          sessions.get(sessionID)?.agent ?? readStringField(message, "agent"),
      },
      message: toAssistantMessageInfo(message, sessionID),
      sessionModelID: null,
    });
    await persist(sessionID);
  };

  // wireFetch chains over a user-configured fetch (proxy/CA/agent) when one
  // exists — the config hook passes it in; otherwise the global fetch. The
  // wrapper only takes over the SSE chat endpoint; everything else is passed
  // through UNCHANGED so any pre-existing custom fetch behavior survives.
  const wireFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    next?: FetchLike,
  ): Promise<Response> => {
    const upstream =
      next ??
      ((input2: RequestInfo | URL, init2?: RequestInit) =>
        fetch(input2, init2));
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.endsWith(CHAT_COMPLETIONS_SUFFIX)) return upstream(input, init);
    // belt & suspenders vs the event route: child sessions never come to pend
    if (headerOf(input, init, PARENT_SESSION_HEADER))
      return upstream(input, init);
    const sessionID = headerOf(input, init, SESSION_HEADER);
    if (!sessionID) return upstream(input, init);
    return measureSseFetch(
      sessionID,
      upstream,
      input as RequestInfo | URL,
      init,
    );
  };

  // Records arrival times / SSE usage while streaming the exact same bytes
  // through to the consumer, then hands the measurement to the session's
  // collector as a pending step (correlation happens on message.updated).
  const measureSseFetch = async (
    sessionID: string,
    next: FetchLike,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const t0 = now();
    const response = await next(input, init);
    if (!response.ok || !response.body) return response;
    const source = response.body;
    const chunks: RecordedChunk[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    let measured = false;
    const finish = () => {
      if (measured) return;
      measured = true;
      const measurement = measurementFromWire({
        t0,
        t2: now(),
        chunks,
        providerID: "ollama-cloud",
        modelID: "unknown",
      });
      if (!measurement) return;
      collectorFor(sessionID).pend(
        {
          ttftMs: measurement.ttftMs,
          tokensOut: measurement.tokensOut,
          decodeMs: measurement.decodeMs,
          source: measurement.source,
          ts: t0,
        },
        {
          sessionID,
          requestParentSessionId: null,
          sessionParentId: sessions.get(sessionID)?.parentId ?? null,
          sessionModelID: null,
          now: t0,
        },
      );
    };
    // process complete SSE lines from a raw byte chunk (call again with ""
    // at stream end to flush a final line without its newline)
    const consume = (raw: string) => {
      const lines = (buffer + raw).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        try {
          const parsed: unknown = JSON.parse(data);
          const usage = (
            parsed as { usage?: { completion_tokens?: unknown } } | null
          )?.usage;
          if (
            usage &&
            typeof usage.completion_tokens === "number" &&
            chunks.length > 0
          )
            chunks[chunks.length - 1].usage = {
              completion_tokens: usage.completion_tokens,
            };
        } catch {
          /* keep-alive comments and non-JSON payloads are normal */
        }
      }
    };
    const upstream2 = source.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await upstream2.read();
            if (done) break;
            if (value !== undefined) {
              chunks.push({ t: now() });
              consume(decoder.decode(value, { stream: true }));
              controller.enqueue(value);
            }
          }
          // flush a final data line that arrived without its trailing newline
          consume(decoder.decode());
        } catch {
          /* aborted stream: measure what actually arrived */
        }
        try {
          controller.close();
        } catch {
          /* consumer already gone */
        }
        finish();
        void persist(sessionID);
      },
      cancel() {
        finish();
      },
    });
    try {
      return new Response(stream, response);
    } catch {
      finish();
      void persist(sessionID);
      return response;
    }
  };

  return { wireFetch, handleEvent, store, collectors, sessions, firstPart };
};
