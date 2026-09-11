// opencode 2.x stats capture (server side): the event route.
//
// V1 wrapped the provider `options.fetch` for wire-accurate TTFT/TPS. The V2
// session `http.request`/`http.response` hooks described by the beta docs are
// NOT dispatched in 0.0.0-beta-19425 (verified empirically: prompt/context/
// model.request/http.* stay silent while the model call succeeds), so this
// module measures through the public event stream instead:
//   session.step.started                      → step start + model attribution
//   session.text/reasoning/tool.input deltas  → first/last stream signal
//   session.step.ended                        → output tokens (usage)
// The numbers are event-clock, not socket-clock: TTFT/TPS are honest but may
// include opencode's event dispatch overhead (V1's D2 retirement of the event
// route was about wire accuracy; under V2 there is no wire seam to prefer).
// The handoff contract (one file per session, same summary/steps shape) is
// unchanged, so the TUI side is unaffected. Everything is best-effort: stats
// must never break a session.
import {
  createHandoffStore,
  MAX_HANDOFF_STEPS,
  type HandoffStore,
} from "./handoff.ts";
import {
  createStatsCollector,
  type StatsCollector,
  type StepMeasurement,
} from "./stats.ts";
import type { DebugSink } from "./capture.ts";
import type { V2Event, V2Registration, V2ServerContext } from "./v2-types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Daemon-long maps need bounds (V1 capture.ts contract): evict the oldest
// insertion-order entry on overflow.
const MAX_SESSIONS = 500;
const MAX_COLLECTORS = 500;
// In-flight steps: a step that never ends (aborted call) must not leak.
const MAX_STEPS = 200;

const evictOldest = <V>(map: Map<string, V>, max: number): void => {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
};

const readString = (value: object, key: string): string | null => {
  const raw: unknown = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

const payloadOf = (event: V2Event): Record<string, unknown> | null => {
  const raw = event.data ?? event.properties;
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : null;
};

/** One in-flight step, keyed by assistantMessageID. */
interface StepState {
  sessionID: string;
  providerID: string;
  modelID: string;
  startedAt: number;
  firstSignalAt: number | null;
  lastSignalAt: number | null;
  signals: number;
}

export interface V2StatsCapture {
  /** Subscribe to the server event stream. */
  attach(ctx: V2ServerContext): Promise<V2Registration[]>;
  store: HandoffStore;
  /** Test seams (V1 capture.ts parity). */
  collectors: Map<string, StatsCollector>;
  parents: Map<string, string | null>;
  steps: Map<string, StepState>;
}

export const createV2StatsCapture = (
  input: {
    now?: () => number;
    handoffDir?: string;
    debugSink?: DebugSink;
  } = {},
): V2StatsCapture => {
  const now = input.now ?? (() => Date.now());
  const debugSink = input.debugSink;
  const store = createHandoffStore(input.handoffDir);
  // D3: sweep stale per-session files once at startup, best-effort like every
  // handoff path.
  void store.cleanup(null, DAY_MS);
  const collectors = new Map<string, StatsCollector>();
  const parents = new Map<string, string | null>();
  const steps = new Map<string, StepState>();
  // Handoff write policy (V1 parity): steps only grow, so a persist never
  // publishes fewer steps than what is already on disk; identical snapshots
  // skip the write.
  const persistedFingerprint = new Map<string, string>();

  const collectorFor = (sessionID: string): StatsCollector => {
    let collector = collectors.get(sessionID);
    if (!collector) {
      collector = createStatsCollector(sessionID);
      collectors.delete(sessionID); // re-insert to keep insertion order fresh
      collectors.set(sessionID, collector);
      evictOldest(collectors, MAX_COLLECTORS);
    }
    return collector;
  };

  /** Session parentID, learned once per session through the V2 session API. */
  const parentOf = async (
    ctx: V2ServerContext,
    sessionID: string,
  ): Promise<string | null> => {
    if (parents.has(sessionID)) {
      const known = parents.get(sessionID) ?? null;
      parents.delete(sessionID);
      parents.set(sessionID, known); // keep insertion order fresh
      return known;
    }
    let parent: string | null = null;
    try {
      const info = await ctx.session.get({ sessionID });
      parent =
        typeof info?.parentID === "string" && info.parentID.length > 0
          ? info.parentID
          : null;
    } catch {
      /* unknown session: treat as root, the per-session file stays isolated */
    }
    parents.delete(sessionID);
    parents.set(sessionID, parent);
    evictOldest(parents, MAX_SESSIONS);
    return parent;
  };

  const persist = async (sessionID: string): Promise<void> => {
    const collector = collectors.get(sessionID);
    if (!collector) return;
    const summary = collector.summary();
    const fingerprint = `${summary.steps}:${summary.tokensOutTotal}:${summary.decodeMsTotal}:${Math.round(summary.avgTtftMs)}`;
    if (persistedFingerprint.get(sessionID) === fingerprint) return;
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

  const logStep = (step: StepMeasurement): void => {
    if (!debugSink) return;
    try {
      debugSink(
        `v2 step session=${step.sessionID} model=${step.modelID} ttftMs=${Math.round(step.ttftMs)} tokensOut=${step.tokensOut} decodeMs=${Math.round(step.decodeMs)} source=${step.source}`,
      );
    } catch {
      /* diagnostics must never break the capture */
    }
  };

  const handleEvent = async (
    ctx: V2ServerContext,
    event: V2Event,
  ): Promise<void> => {
    try {
      // The server event stream is global: every plugin instance receives
      // every location's events. Each instance records only its own location
      // (V1's event listener filtered the same way), otherwise N instances
      // would append the same step N times to the shared handoff file.
      const own = ctx.location?.directory;
      const from = event.location?.directory;
      if (own && from && from !== own) return;
      const type = readString(event, "type");
      if (!type) return;
      const at =
        typeof event.created === "number" && Number.isFinite(event.created)
          ? event.created
          : now();
      const data = payloadOf(event);
      if (!data) return;

      if (type === "session.step.started") {
        const sessionID = readString(data, "sessionID");
        const messageID = readString(data, "assistantMessageID");
        if (!sessionID || !messageID) return;
        // subagent sessions are off the frontier entirely (V1 main-step
        // gate): their file would never be the one the TUI renders for the
        // root session
        if (await parentOf(ctx, sessionID)) return;
        const model = (data.model ?? null) as Record<string, unknown> | null;
        const providerID = model ? readString(model, "providerID") : null;
        const modelID = model ? readString(model, "id") : null;
        steps.delete(messageID); // re-insert to keep insertion order fresh
        steps.set(messageID, {
          sessionID,
          providerID: providerID ?? "unknown",
          modelID: modelID ?? "unknown",
          startedAt: at,
          firstSignalAt: null,
          lastSignalAt: null,
          signals: 0,
        });
        evictOldest(steps, MAX_STEPS);
        return;
      }

      if (
        type === "session.reasoning.delta" ||
        type === "session.text.delta" ||
        type === "session.tool.input.delta"
      ) {
        const messageID = readString(data, "assistantMessageID");
        const state = messageID ? steps.get(messageID) : undefined;
        if (!state) return;
        if (state.firstSignalAt === null) state.firstSignalAt = at;
        state.lastSignalAt = at;
        state.signals += 1;
        return;
      }

      if (type === "session.step.ended") {
        const messageID = readString(data, "assistantMessageID");
        const state = messageID ? steps.get(messageID) : undefined;
        if (!state || !messageID) return;
        steps.delete(messageID);
        const tokens = (data.tokens ?? null) as Record<string, unknown> | null;
        const tokensOut =
          tokens && typeof tokens.output === "number" ? tokens.output : 0;
        // a step with no output tokens is not a step (V1 contract)
        if (!Number.isFinite(tokensOut) || tokensOut <= 0) return;
        const first = state.firstSignalAt ?? at;
        const last = state.lastSignalAt ?? first;
        const step: StepMeasurement = {
          sessionID: state.sessionID,
          providerID: state.providerID,
          modelID: state.modelID,
          ttftMs: Math.max(0, first - state.startedAt),
          tokensOut,
          decodeMs: Math.max(0, last - first),
          // a step with a single stream signal has no decode window to speak
          // of — same "(direct)" label V1 gave single-chunk wire responses
          source: state.signals <= 1 ? "wire-nostream" : "wire",
          ts: state.startedAt,
        };
        collectorFor(state.sessionID).record(step);
        logStep(step);
        void persist(state.sessionID);
      }
    } catch (error) {
      console.warn(
        "[opencode-ollama-cloud] stats capture ignored an event error:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  const attach = async (ctx: V2ServerContext): Promise<V2Registration[]> => {
    const controller = new AbortController();
    const subscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          await handleEvent(ctx, event);
        }
      } catch {
        /* stream aborted on unload, or the host stopped it */
      }
    })();
    return [
      {
        dispose: async () => {
          controller.abort();
          await subscription.catch(() => {});
        },
      },
    ];
  };

  return { attach, store, collectors, parents, steps };
};
