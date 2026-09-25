// TUI plugin module of the stats effort (tickets 04/05/07). One source, two
// hosts:
//   - V1 (opencode 1.x): the default `tui(api, options)` factory. opencode's
//     own loader transpiles this .tsx at runtime and rewrites solid-js /
//     @opentui specifiers to shared runtime modules (packages/opencode/src/
//     plugin/tui/runtime.ts) — no local build needed.
//   - V2 (opencode 2.x): the default `setup(ctx)` factory. The V2 host loads
//     `exports["./tui"]` from node_modules, where its Solid JSX transform does
//     NOT run (its onLoad filter excludes node_modules) — raw JSX would fall
//     back to Bun's React runtime and fail with "Cannot find package 'react'".
//     So the shipped TUI entry is the precompiled `plugin/tui.js` (built by
//     `bun run build:tui`), whose JSX imports @opentui/solid/jsx-runtime — a
//     shared runtime module the host DOES rewrite in node_modules files.
//
// Silent degradation contract: every step is feature-detected; if the
// undocumented TUI API moved, this module logs once and retires — the server
// module (provider/catalog/stats capture) is unaffected because these are
// separate modules in separate processes, sharing ONLY the handoff file.
import { createSignal } from "solid-js";
import {
  formatLiveLine,
  formatStatsDialogBody,
  pickSessionFile,
  pickTuiFeatures,
  resolveSessionID,
} from "./tui-display.ts";
import {
  createHandoffStore,
  DEFAULT_HANDOFF_DIR,
  type HandoffFile,
} from "./handoff.ts";
import { readUpdateRecord } from "./self-update.ts";
import { logDeprecatedV1 } from "./version.ts";
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
// confirm/clear path): the 1 s poll re-renders its body while it is open.
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

// ---------------------------------------------------------------------------
// V2 TUI entry (opencode 2.x): same stats UI, host API `setup(ctx)`. The V2
// contract is `{ id, setup }` (the module's `tui` member is ignored there);
// `slot({ append, render })` registers the live line and `keymap.layer`
// registers the /stats palette command. Typed structurally: the published
// @opencode-ai/plugin typings do not cover the V2 TUI context.
// ---------------------------------------------------------------------------
interface TuiV2Theme {
  textMuted?: string;
  text?: string | { muted?: string };
}
interface TuiV2Context {
  options?: { stats?: string; deprecation?: unknown };
  app?: { version?: string };
  theme?: TuiV2Theme;
  keymap?: { layer?: (factory: () => unknown) => unknown };
  ui?: {
    slot?: (claim: {
      append?: string;
      render: (props?: { session_id?: string }) => unknown;
    }) => unknown;
    dialog?: {
      show?: (render: () => unknown, onClose?: () => void) => void;
      clear?: () => void;
      alert?: (opts: { title: string; message: string }) => Promise<unknown>;
    };
    router?: { current?: () => unknown };
  };
}

// V2 theme tokens: the V1 typings name the flat key `textMuted`; newer hosts
// expose `text.muted`. Support both, never guess a colour.
const mutedFg = (theme: TuiV2Theme | undefined): string | undefined => {
  if (typeof theme?.textMuted === "string") return theme.textMuted;
  const nested = (theme?.text as { muted?: unknown } | undefined)?.muted;
  return typeof nested === "string" ? nested : undefined;
};

function setupV2Tui(ctx: TuiV2Context): (() => void) | undefined {
  debug("v2 setup entry, version", String(ctx?.app?.version ?? "?"));
  try {
    // knob (ticket 08): opt-out supported from BOTH module entries
    if (ctx?.options?.stats === "off") {
      debug("stats off — retiring before any registration");
      return;
    }
    const slot = ctx?.ui?.slot;
    if (typeof slot !== "function") {
      debug("v2 ui.slot missing; stats UI retires silently");
      return;
    }
    const routeCurrent = (): unknown => ctx?.ui?.router?.current?.();

    const [line, setLine] = createSignal<string>(formatLiveLine(null));
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
    const refresh = async (sessionID?: string) => {
      try {
        // props win; the route accessor covers sessions created after mount
        const sid =
          sessionID ?? resolveSessionID(undefined, { current: routeCurrent() });
        if (sid) activeSessionID = sid;
        const file = await sessionFile(sid);
        const next = formatLiveLine(file?.summary ?? null);
        if (next !== lastLine) {
          debug("v2 line:", "active=", String(sid ?? "none"), "->", next);
          lastLine = next;
        }
        setLine(next);
      } catch (error) {
        debug(
          "v2 refresh error:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    slot({
      append: "session_prompt_right",
      render: (props) => {
        try {
          const sid = resolveSessionID(props?.session_id, {
            current: routeCurrent(),
          });
          if (sid) activeSessionID = sid;
          void refresh(sid ?? undefined);
          const b = badge();
          return (
            <text fg={mutedFg(ctx?.theme)}>
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
          debug("v2 slot render error:", msg);
          return null;
        }
      },
    });
    debug("v2 slot session_prompt_right registered");

    // /stats: a live dialog over the same handoff read (best-effort). The
    // dialog body is a signal: the 1 s poll re-renders it while it is open.
    const [dialogBody, setDialogBody] = createSignal<string>("");
    let dialogOpen = false;
    const openDialog = (): void => {
      const dialog = ctx?.ui?.dialog;
      if (typeof dialog?.show === "function") {
        dialog.show(
          () => <text>{dialogBody()}</text>,
          () => {
            dialogOpen = false;
          },
        );
        dialogOpen = true;
      } else if (typeof dialog?.alert === "function") {
        void dialog.alert({ title: "/stats", message: dialogBody() });
      }
    };
    const showStats = async (): Promise<void> => {
      try {
        setDialogBody(await statsBody());
        openDialog();
      } catch (error) {
        dialogOpen = false;
        debug(
          "v2 /stats failed silently:",
          error instanceof Error ? error.message : String(error),
        );
        try {
          ctx?.ui?.dialog?.clear?.();
        } catch {
          /* nothing to clear */
        }
      }
    };
    const refreshDialog = async (): Promise<void> => {
      if (!dialogOpen) return;
      try {
        const body = await statsBody();
        // the read awaits ~120 ms: the dialog may have been closed meanwhile
        if (dialogOpen) setDialogBody(body);
      } catch (error) {
        debug(
          "v2 stats dialog refresh error:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const poll = setInterval(() => {
      void refresh();
      void refreshDialog();
    }, 1000);
    try {
      poll.unref?.();
    } catch {
      /* unref is Node/Bun-specific; fine to keep the interval un-unref'd */
    }
    const badgePoll = setInterval(() => void refreshBadge(), 30000);
    try {
      badgePoll.unref?.();
    } catch {
      /* same as above */
    }

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      try {
        clearInterval(poll);
        clearInterval(badgePoll);
        dialogOpen = false;
      } catch {
        /* silent-degradation contract: dispose never throws */
      }
    };

    // The command is registered from INSIDE a slot render: ctx.keymap.layer
    // (createLayer) needs the host's Keymap.Provider context, which only
    // exists within the rendered tree — the built-in stats plugin does the
    // same from its `app` slot. Registering it directly in setup throws
    // "Keymap.Provider is missing".
    slot({
      append: "app",
      render: () => {
        const layer = ctx?.keymap?.layer;
        if (typeof layer !== "function") return null;
        try {
          return layer(() => ({
            mode: "global",
            commands: [
              {
                id: "opencode-ollama-cloud.stats.show",
                title: "Ollama Cloud stats",
                group: "Plugins",
                palette: true,
                run() {
                  void showStats();
                },
              },
            ],
          }));
        } catch (error) {
          debug(
            "v2 keymap layer error:",
            error instanceof Error ? error.message : String(error),
          );
          return null;
        }
      },
    });
    return dispose;
  } catch (error) {
    // degradación silenciosa: stats UI down, provider/catalog untouched
    debug(
      "v2 setup threw:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return;
  }
}

export default {
  id: "opencode-ollama-cloud-tui",
  setup: setupV2Tui,
  async tui(
    api: TuiLike,
    options?: {
      stats?: string;
      deprecation?: unknown;
    },
  ) {
    debug(
      "tui module entry, version",
      String((api as { app?: { version?: string } }).app?.version ?? "?"),
    );
    // This factory is the V1 path (opencode 1.x); the V2 host calls `setup`
    // instead. Presence here therefore means v1: one silent log line.
    logDeprecatedV1(options?.deprecation);
    try {
      // knob (ticket 08): opt-out supported from BOTH module entries
      if (options?.stats === "off") {
        debug("stats off — retiring before any registration");
        return;
      }
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
        api.keymap?.registerLayer({
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
