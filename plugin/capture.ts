// Server side of the stats capture (spec Pieza 1): wire-accurate measurement
// for ollama-cloud via a fetch wrapper, the per-session in-memory store that
// feeds the handoff, and the event sink that correlates wire measurements with
// their assistant messages. The event-derived measurement route was RETIRED
// (D2: stats measure ONLY ollama-cloud, and only through the wire). Everything
// here is defensive: the plugin must never break a session over stats.
// Verified opencode surfaces (fetch seam, event payloads, header signals) are
// documented in research/capacidades-opencode-ui-stats.md.
import type { RecordedChunk } from "./stats.ts";
import {
  createStatsCollector,
  isCompactionMessage,
  measurementFromWire,
  type ClaimAttempt,
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
const DAY_MS = 24 * 60 * 60 * 1000;

/** Read a possibly-untyped runtime field (the SDK typings lag opencode's schema). */
const readStringField = (value: object, key: string): string | null => {
  const raw: unknown = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

/** message.time.created, or null when absent/non-positive (no time to correlate by). */
const messageTimeCreatedOf = (
  message: Record<string, unknown>,
): number | null => {
  const time = message.time as { created?: unknown } | undefined;
  const created = time?.created;
  return typeof created === "number" && Number.isFinite(created) && created > 0
    ? created
    : null;
};

/** fetch-assignable shape (Bun's typeof fetch adds preconnect). */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Diagnostics sink for claim attempts (statsDebug knob); must never throw. */
export type DebugSink = (line: string) => void;

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

// Degradations are surfaced ONCE per process — a broken seam must not flood
// opencode's logs, but the user deserves one honest hint that stats died.
const warned = new Set<string>();
const warnOnce = (message: string): void => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[opencode-ollama-cloud] ${message}`);
};

// Bound for the daemon-long session maps: evict the oldest (insertion-order
// first) entry on overflow — stats are best-effort instrumentation, never
// allowed to leak memory.
const evictOldest = <V>(map: Map<string, V>, max: number): void => {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
};

export const createStatsCapture = (
  input: {
    now?: () => number;
    handoffDir?: string;
    debugSink?: DebugSink;
  } = {},
) => {
  const now = input.now ?? (() => Date.now());
  const debugSink = input.debugSink;
  const store = createHandoffStore(input.handoffDir);
  // D3: retire the legacy single-slot stats.json and sweep stale per-session
  // files once at startup — fire and forget, best-effort like every handoff path.
  void store.cleanup(null, DAY_MS);
  const collectors = new Map<string, StatsCollector>();
  const sessions = new Map<
    string,
    { parentId: string | null; agent: string | null }
  >();
  // daemon-long maps need bounds: evict oldest on overflow (see evictOldest)
  const MAX_SESSIONS = 500;
  const MAX_COLLECTORS = 500;

  const rememberSession = (
    id: string,
    entry: { parentId: string | null; agent: string | null },
  ) => {
    sessions.delete(id); // re-insert to keep insertion order fresh
    sessions.set(id, entry);
    evictOldest(sessions, MAX_SESSIONS);
  };

  const collectorFor = (sessionID: string): StatsCollector => {
    let collector = collectors.get(sessionID);
    if (!collector) {
      collector = createStatsCollector(sessionID);
      collectors.delete(sessionID); // re-insert to keep insertion order fresh
      collectors.set(sessionID, collector);
      // evicting an ACTIVE session's collector loses its in-memory stats —
      // acceptable: the daemon is best-effort instrumentation, and the map
      // bound is what keeps a daemon-long process from leaking memory
      evictOldest(collectors, MAX_COLLECTORS);
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
    const fingerprint = `${summary.steps}:${summary.tokensOutTotal}:${summary.decodeMsTotal}:${Math.round(summary.avgTtftMs)}`;
    if (persistedFingerprint.get(sessionID) === fingerprint) return;
    // per-session files narrow the guard to THIS session's snapshot: an on-disk
    // state with more steps than memory (e.g. the plugin process restarted) wins
    const current = await store.read(sessionID);
    if (current && current.summary.steps > summary.steps) {
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

  // Claim instrumentation (statsDebug): one line per claim attempt — ISO time,
  // session, agent, tokens, candidate pendings and the outcome. The sink is
  // already failure-proof on its side; the guard here keeps a hostile sink
  // from ever breaking a session.
  const logClaim = (
    sessionID: string,
    agent: string | null,
    tokensOut: number | null,
    attempt: ClaimAttempt,
  ): void => {
    if (!debugSink) return;
    const pends = attempt.pendings.map((p) => `${p.ts}:${p.source}`).join(" ");
    try {
      debugSink(
        `claim session=${sessionID} agent=${agent ?? "-"} tokensOut=${tokensOut ?? "-"} pendings=${attempt.pendings.length} result=${attempt.result}${pends.length > 0 ? ` pends=[${pends}]` : ""}`,
      );
    } catch {
      /* diagnostics must never break the capture */
    }
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

      // D2: message.updated does ONLY the wire claim now — a session without
      // a collector has no wire measurement to correlate (other providers
      // never reach here, and creating empty collectors would be pure waste)
      const collector = collectors.get(sessionID);
      if (!collector) return;

      const messageInfo = toAssistantMessageInfo(message, sessionID);
      const isCompaction = isCompactionMessage(messageInfo);

      // the session's active agent: the first non-compaction assistant message
      // defines it (no constants — build/plan/custom agents exist)
      if (
        !isCompaction &&
        sessionInfo &&
        sessionInfo.agent == null &&
        messageInfo.agent
      ) {
        rememberSession(sessionID, {
          ...sessionInfo,
          agent: messageInfo.agent,
        });
      }

      // compaction reaches the claim too: its pending attaches and is dropped
      // by the main-step gate (consumed, never leaked into the next real step)
      const attempt = collector.claim({
        now: now(),
        sessionID,
        session: {
          parentID: sessionInfo?.parentId ?? null,
          agent: sessionInfo?.agent ?? messageInfo.agent,
        },
        message: messageInfo,
        messageTimeCreated: messageTimeCreatedOf(message),
      });
      const tokens = message.tokens as { output?: unknown } | undefined;
      logClaim(
        sessionID,
        messageInfo.agent,
        typeof tokens?.output === "number" ? tokens.output : null,
        attempt,
      );
      await persist(sessionID);
    } catch (error) {
      console.warn(
        "[opencode-ollama-cloud] stats capture ignored an event error:",
        error instanceof Error ? error.message : error,
      );
    }
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
    // child sessions never come to pend (belt & suspenders)
    if (headerOf(input, init, PARENT_SESSION_HEADER))
      return upstream(input, init);
    const sessionID = headerOf(input, init, SESSION_HEADER);
    if (!sessionID) {
      // the opencode seam changed: chat requests always used to carry the
      // session header. Without it there is nothing to correlate by — say so,
      // once, instead of dying silently.
      warnOnce(
        "stats capture: request reached the provider fetch without x-session-id; stats disabled until restored",
      );
      return upstream(input, init);
    }
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
    let ended = false;
    let aborted = false;
    const finish = () => {
      if (measured) return;
      measured = true;
      const t2 = now();
      const measurement = measurementFromWire({
        t0,
        t2,
        chunks,
        providerID: "ollama-cloud",
        modelID: "unknown",
      });
      if (!measurement) {
        // a stream that produced bytes but no usage payload would be dropped
        // with no explanation — one hint is all the user gets. Aborted or
        // cancelled streams never receive the final usage chunk by design, so
        // they stay silent: a user cancellation is not a diagnostic event.
        if (
          ended &&
          !aborted &&
          chunks.length > 0 &&
          !chunks.some((c) => c.usage != null)
        )
          warnOnce(
            "no usage chunk seen; steps will be dropped (include_usage missing?)",
          );
        return;
      }
      // the window anchors at the STREAM END (not the request start): a slow
      // step must not have its pending expire while the stream is still open
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
          now: t2,
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
          ended = true;
        } catch {
          aborted = true; /* aborted stream: measure what actually arrived */
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
        aborted = true; // consumer cancelled: drop silently, never warn
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

  return { wireFetch, handleEvent, store, collectors, sessions };
};
