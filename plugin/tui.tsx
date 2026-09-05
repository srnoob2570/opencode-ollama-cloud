// TUI plugin module of the stats effort (tickets 04/05/07). opencode loads
// this through its own loader, which transpiles plugin .tsx at runtime and
// rewrites solid-js/@opentui imports to shared runtime modules (verified in
// packages/opencode/src/plugin/tui/runtime.ts) — so this file needs no local
// build deps, only that opencode >= 1.18 is running it.
//
// Silent degradation contract: every step is feature-detected; if the
// undocumented TUI API moved, this module logs once and retires — the server
// module (provider/catalog/stats capture) is unaffected because these are
// separate modules in separate processes, sharing ONLY the handoff file.
import { createSignal } from "solid-js";
import {
  configuredCatalogUrl,
  formatLiveLine,
  formatModelCard,
  formatStatsDialogBody,
  pickSessionFile,
  pickTuiFeatures,
  pricingActive,
  resolveSessionID,
  type ModelCard,
} from "./tui-display.ts";
import {
  createHandoffStore,
  DEFAULT_HANDOFF_DIR,
  type HandoffFile,
} from "./handoff.ts";
import { readUpdateRecord } from "./self-update.ts";
import { loadCatalog, loadPricing, type Catalog } from "./catalog.ts";
import type { SessionSummary } from "./stats.ts";
import { appendBoundedLog } from "./debug-sink.ts";
import { join } from "node:path";

interface TuiLike {
  slots: {
    register: (plugin: {
      order?: number;
      slots: Record<
        string,
        (ctx: unknown, props: { session_id?: string }) => unknown
      >;
    }) => string;
  };
  keymap?: { registerLayer: (layer: Record<string, unknown>) => unknown };
  lifecycle?: { onDispose?: (dispose: () => void) => unknown };
  log?: {
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  event?: {
    on: (type: string, handler: (event: unknown) => void) => () => void;
  };
  theme: { current: { textMuted?: string; text?: string } };
  state?: { config?: { plugin?: unknown } };
  // reactive accessor: route.current → {type:"session", params:{sessionID}}
  // for session screens ({type:"home"} carries no params)
  route?: { readonly current?: unknown };
  ui: {
    dialog: {
      replace: (render: () => unknown, onClose?: () => void) => void;
      clear: () => void;
    };
    DialogAlert: (props: {
      title: string;
      message: string;
      onConfirm?: () => void;
    }) => unknown;
  };
}

const handoff = createHandoffStore();
const ZERO_SUMMARY: SessionSummary = {
  steps: 0,
  tokensOutTotal: 0,
  decodeMsTotal: 0,
  avgTps: 0,
  avgTtftMs: 0,
};

// TUI-process diagnostics: the plugin logs go to opencode's files, but THIS
// module runs in the TUI process whose failures show no trace there — mirror
// omo-slim's own-log pattern (append-only, bounded — appendBoundedLog) so
// failures are legible.
const DEBUG_FILE = join(DEFAULT_HANDOFF_DIR, "tui-debug.log");
const debug = (...message: unknown[]) =>
  appendBoundedLog(
    DEBUG_FILE,
    `[${new Date().toISOString()}] ${message.map(String).join(" ")}\n`,
  );

// the live slot is the only component that knows the active session; dialogs
// reuse it so one opencode window can never render another session's stats
let activeSessionID: string | null = null;

// whether a /stats dialog is currently open (set by showStats, cleared on the
// confirm/clear path and whenever another dialog of ours replaces it): the
// 1 s poll re-renders its body while it is open. /model is snapshot-only and
// never sets this.
let statsDialogOpen = false;

// Handoff reads are throttled but never stale on purpose: each refresh waits
// its slot (~120 ms) and then reads FRESH — a TTL cache can swallow the final
// persist (the exact bug that froze the live line on dashes). Per-session
// since D3: each read targets exactly one stats-<sessionID>.json.
let lastReadAt = 0;
const readFreshHandoff = async (
  sessionID: string,
): Promise<HandoffFile | null> => {
  const wait = Math.max(0, 120 - (Date.now() - lastReadAt));
  try {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return await handoff.read(sessionID);
  } finally {
    lastReadAt = Date.now();
  }
};
const sessionFile = async (
  sessionID?: string | null,
): Promise<HandoffFile | null> => {
  const sid = sessionID ?? activeSessionID;
  if (!sid) return null;
  const file = await readFreshHandoff(sid);
  // hard guard (pickSessionFile): while no session is active NOTHING may
  // display — a startup render must never surface a stale file from a
  // previous launch — and the file must be THIS session's
  return pickSessionFile(file, activeSessionID);
};

// opencode-side observability: the TUI process's failures leave no trace in
// opencode's logs, so when the api exposes a logger, mirror them there too —
// fully feature-detected, silent when absent (tui-debug.log stays the
// always-on record).
const logToOpencode = (api: TuiLike, ...message: unknown[]): void => {
  try {
    if (typeof api.log?.warn === "function") api.log.warn(...message);
    else if (typeof api.log?.error === "function") api.log.error(...message);
  } catch {
    /* logging must never break rendering */
  }
};

// /model consults the catalog; memoize the promise (TTL) so opening the
// dialog never races the CDN mirrors every time. The catalogUrl is the one
// the user configured (either entry — same doors as the server entry), set
// once at module entry; a custom catalog rides with NO rate table (the
// rateless contract) instead of mixing our rates into its ids.
let catalogUrl: string | undefined;

// Shared TTL memo behind catalogOnce/pricingOnce: one promise per window,
// failures degrade to null and are retried only after the TTL expires.
function ttlMemo<T>(load: () => Promise<T>): () => Promise<T | null> {
  const TTL_MS = 60_000;
  let cache: { at: number; promise: Promise<T | null> } | null = null;
  return () => {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), promise: load().catch(() => null) };
    }
    return cache.promise;
  };
}

const catalogOnce = ttlMemo(() => loadCatalog({ catalogUrl }));

// The official-rate table joins the catalog for the /model card; memoized on
// the same TTL and equally best-effort (no table → the card shows dashes).
const pricingOnce = ttlMemo(() => loadPricing({ catalogUrl }));

// The /stats body is the same string at open and on every live re-render:
// one computation, one model-attribution rule (the header names the LAST
// model; the average spans model switches by design).
const statsBody = async (): Promise<string> => {
  const file = await sessionFile();
  return formatStatsDialogBody(
    file?.summary ?? ZERO_SUMMARY,
    file?.steps ?? [],
    file?.steps[0]?.modelID ?? "—",
    Date.now(),
  );
};
const renderStatsDialog = (api: TuiLike, body: string): void => {
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "/stats",
      message: body,
      onConfirm: () => {
        statsDialogOpen = false;
        api.ui.dialog.clear();
      },
    }),
  );
  // only after replace succeeded: a throw here leaves no dialog to refresh
  statsDialogOpen = true;
};

const showStats = async (api: TuiLike): Promise<void> => {
  try {
    renderStatsDialog(api, await statsBody());
  } catch (error) {
    statsDialogOpen = false;
    console.warn(
      "[opencode-ollama-cloud/tui] /stats failed silently:",
      error instanceof Error ? error.message : error,
    );
    api.ui.dialog.clear();
  }
};

// Live /stats: the body was computed once at open, so while the dialog is
// open each poll tick recomputes and re-renders it. Best-effort — a failed
// tick leaves the dialog as-is and the next one retries (silent degradation).
const refreshStatsDialog = async (api: TuiLike): Promise<void> => {
  if (!statsDialogOpen) return;
  try {
    const body = await statsBody();
    // the read awaits ~120 ms: the dialog may have been closed/disposed
    // meanwhile, and re-renders must never resurrect it
    if (!statsDialogOpen) return;
    renderStatsDialog(api, body);
  } catch (error) {
    debug(
      "stats dialog refresh error:",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const showModel = async (api: TuiLike, pricingOn: boolean): Promise<void> => {
  try {
    const file = await sessionFile();
    const modelID = file?.steps[0]?.modelID;
    let body =
      "  Card\n\n  Quantization      — (unavailable)\n\n  (model outside the catalog, nothing estimated)";
    let title = "/model";
    if (modelID) {
      try {
        const [catalog, rates] = await Promise.all([
          catalogOnce(),
          pricingOnce(),
        ]);
        const model: Catalog["models"][number] | undefined =
          catalog?.models.find((m) => m.id === modelID);
        if (model) {
          const card: ModelCard = {
            id: model.id,
            name: model.name,
            family: model.family,
            releaseDate: model.releaseDate,
            quantization: model.quantization,
            quantizationSource: model.sources?.quantization,
            context: model.context,
            maxOutput: model.maxOutput,
            capabilities: model.capabilities,
            pricing: rates?.[model.id] ?? null,
          };
          body = formatModelCard(card, pricingOn);
        } else {
          title = `/model · ${modelID} (not in catalog)`;
        }
      } catch {
        title = `/model · ${modelID} (catalog unavailable)`;
      }
    } else {
      body =
        "  No measured responses yet in this session —\n  run /model after a response";
    }
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title,
        message: body,
        onConfirm: () => api.ui.dialog.clear(),
      }),
    );
    // /model just replaced whatever dialog was open — the /stats dialog is
    // gone, so the poll must not resurrect it over this card
    statsDialogOpen = false;
  } catch (error) {
    console.warn(
      "[opencode-ollama-cloud/tui] /model failed silently:",
      error instanceof Error ? error.message : error,
    );
    api.ui.dialog.clear();
  }
};

export default {
  id: "opencode-ollama-cloud-tui",
  async tui(
    api: TuiLike,
    options?: {
      stats?: string;
      pricing?: string;
      catalogUrl?: string;
    },
  ) {
    debug(
      "tui module entry, version",
      String((api as { app?: { version?: string } }).app?.version ?? "?"),
    );
    try {
      // knob (ticket 08): opt-out supported from BOTH module entries
      if (options?.stats === "off") {
        debug("stats off — retiring before any registration");
        return;
      }
      // Same doors as the server entry: a configured catalogUrl (own options
      // or the server entry's) replaces the default mirrors for /model.
      catalogUrl = configuredCatalogUrl(api.state?.config, {
        catalogUrl: options?.catalogUrl,
      });
      const features = pickTuiFeatures(api);
      debug("features:", JSON.stringify(features));
      if (!features.slots) {
        debug("slots API missing; stats UI retires silently");
        return;
      }

      const [line, setLine] = createSignal<string>(formatLiveLine(null));
      // update badge (self-update effort): the server writes update.json when
      // it staged a newer release for the next restart; the TUI shows it as a
      // suffix on the live line until the record is cleared. Best-effort: the
      // line survives without it.
      const [badge, setBadge] = createSignal<string>("");
      const refreshBadge = async () => {
        try {
          const record = await readUpdateRecord();
          setBadge(record ? `↑ ${record.latest}` : "");
        } catch {
          /* the badge is decoration, never a failure */
        }
      };
      void refreshBadge();
      let lastLine: string | null = null;
      // route fallback: the slot's renderer runs once and its node is cached,
      // so props.session_id never re-arrives for a session created after
      // mount — re-reading opencode's route accessor covers that gap
      const routeSession = (): string | null =>
        resolveSessionID(undefined, api.route);
      const refresh = async (sessionID?: string) => {
        try {
          // reads for the prop's session (falling back to the route, then to
          // the active one); null → sessionFile returns null → "—"
          const sid = sessionID ?? routeSession();
          if (sid) activeSessionID = sid;
          const file = await sessionFile(sid);
          const next = formatLiveLine(file?.summary ?? null);
          // one log line per actual CHANGE of the shown value (idle+trailing
          // re-reads would spam otherwise); errors always log
          if (next !== lastLine) {
            debug(
              "line:",
              "active=",
              String(sid ?? "none"),
              "steps=",
              String(file?.summary?.steps ?? -1),
              "->",
              next,
            );
            lastLine = next;
          }
          setLine(next);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          debug("refresh error:", msg);
          logToOpencode(
            api,
            "[opencode-ollama-cloud/tui] stats refresh failed:",
            msg,
          );
        }
      };

      api.slots.register({
        order: 100,
        slots: {
          session_prompt_right: (
            _ctx: unknown,
            props: { session_id?: string },
          ) => {
            try {
              // only a render that KNOWS the session may update the pointer —
              // resolved from props first, then from opencode's own route
              // state; transient prop-less renders keep the last known session
              const sid = resolveSessionID(props?.session_id, api.route);
              if (sid) activeSessionID = sid;
              void refresh(sid ?? undefined);
              const b = badge();
              return (
                <text fg={api.theme?.current?.textMuted}>
                  {" "}
                  {line()}
                  {b ? ` ${b}` : ""}{" "}
                </text>
              );
            } catch (error) {
              const msg =
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error);
              debug("slot render error:", msg);
              logToOpencode(
                api,
                "[opencode-ollama-cloud/tui] stats slot render failed:",
                msg,
              );
              return null;
            }
          },
        },
      });
      debug("slot session_prompt_right registered");

      // D3 housekeeping, once per TUI launch: drop other sessions' handoff
      // files and anything older than a day (also the legacy v1 stats.json).
      // Best-effort and awaited nowhere — registration never waits on it.
      try {
        void handoff
          .cleanup(null, 24 * 60 * 60 * 1000)
          .then((deleted) =>
            debug("handoff cleanup deleted", String(deleted), "file(s)"),
          )
          .catch((error) =>
            debug(
              "handoff cleanup error:",
              error instanceof Error ? error.message : String(error),
            ),
          );
      } catch {
        /* cleanup is housekeeping, not a dependency */
      }

      // Keep the live line fresh. Verified against opencode's source: the
      // server plugin hook is dispatched fire-and-forget while the TUI bus
      // delivers the same message.updated FIRST — every event-driven read
      // loses the race against the final persist. So: events for instant
      // updates, trailing re-reads after session.idle (emitted after
      // completed+DB-persist; our hook's file write lags it by ms), and a
      // 1 s poll as the convergence floor.
      const unsubscribers: Array<() => void> = [];
      try {
        const offUpdated = api.event?.on?.(
          "message.updated",
          () => void refresh(),
        );
        if (typeof offUpdated === "function") unsubscribers.push(offUpdated);
        const offIdle = api.event?.on?.("session.idle", () => {
          void refresh();
          setTimeout(() => void refresh(), 200);
          setTimeout(() => void refresh(), 700);
        });
        if (typeof offIdle === "function") unsubscribers.push(offIdle);
      } catch {
        /* event bus unavailable: the poll still covers it */
      }
      const poll = setInterval(() => {
        void refresh();
        // live /stats: re-render the open dialog's body on the same floor
        void refreshStatsDialog(api);
      }, 1000);
      try {
        poll.unref?.();
      } catch {
        /* unref is Node/Bun-specific; fine to keep the interval un-unref'd */
      }
      // the record can land after this TUI mounted (the server's npm fetch is
      // still in flight at boot) — re-read on a slow floor, best-effort
      const badgePoll = setInterval(() => void refreshBadge(), 30000);
      try {
        badgePoll.unref?.();
      } catch {
        /* same as above */
      }

      // disposal: when opencode announces the TUI is going away, release
      // everything this module registered (event subs, poll, dialog-refresh
      // state); feature-detected — builds without the lifecycle API simply
      // keep the unref'd poll until process exit.
      let disposed = false;
      const dispose = () => {
        if (disposed) return; // idempotent: opencode may call it more than once
        disposed = true;
        try {
          for (const off of unsubscribers) {
            try {
              off();
            } catch {
              /* one failing unsubscribe must not stop the rest */
            }
          }
          clearInterval(poll);
          clearInterval(badgePoll);
          statsDialogOpen = false;
        } catch {
          /* silent-degradation contract: dispose never throws */
        }
      };
      try {
        if (typeof api.lifecycle?.onDispose === "function")
          api.lifecycle.onDispose(dispose);
      } catch {
        /* no disposal API: the unref'd poll dies with the process */
      }

      if (features.keymap) {
        // the pricing knob lives on the server entry (README) — scan config
        const pricingOn = pricingActive(api.state?.config, {
          pricing: options?.pricing,
        });
        api.keymap.registerLayer({
          commands: [
            {
              name: "opencode-ollama-cloud.stats.show",
              title: "Stats",
              category: "Ollama Cloud",
              namespace: "palette",
              slashName: "stats",
              run() {
                void showStats(api);
              },
            },
            {
              name: "opencode-ollama-cloud.model.show",
              title: "Model card",
              category: "Ollama Cloud",
              namespace: "palette",
              slashName: "model",
              run() {
                void showModel(api, pricingOn);
              },
            },
          ],
        });
      }
    } catch (error) {
      // degradación silenciosa: stats UI down, provider/catalog untouched
      debug(
        "tui() threw:",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      console.warn(
        "[opencode-ollama-cloud/tui] stats UI retired silently:",
        error instanceof Error ? error.message : error,
      );
    }
  },
};
