/** @jsxImportSource @opentui/solid */
// TUI plugin module of the stats effort, opencode 2.x (V2) side of the
// dual-support port. V2's TUI host reads `default.id` + `default.setup(ctx)`
// instead of calling `default.tui(api, options)` like V1; ./tui.tsx spreads
// this module's plugin object and keeps the V1 entry, so one entry file works
// on both hosts.
//
// opencode transpiles plugin .tsx at runtime and rewrites solid-js/OpenTUI
// imports to shared runtime modules, so this file needs no local build deps —
// only an opencode 2.x host. Types are structural and local (same style as
// `TuiLike` in ./tui.tsx): V2 is beta and importing its published types would
// pin a V1-compatible package to a moving target.
//
// Silent degradation contract: every step is feature-detected and every
// failure is swallowed — if the undocumented TUI API moved, this module logs
// once and retires; the server module (provider/catalog/stats capture) is
// unaffected because these are separate modules in separate processes,
// sharing ONLY the handoff file.
import { createSignal, onCleanup } from "solid-js";
import {
  formatLiveLine,
  formatModelCard,
  formatStatsDialogBody,
  pickSessionFile,
  pricingKnob,
  type ModelCard,
} from "./tui-display.ts";
import {
  createHandoffStore,
  DEFAULT_HANDOFF_DIR,
  type HandoffFile,
} from "./handoff.ts";
import { readUpdateRecord } from "./self-update.ts";
import { loadCatalog, type Catalog } from "./catalog.ts";
import type { SessionSummary } from "./stats.ts";
import { appendBoundedLog } from "./debug-sink.ts";
import { join } from "node:path";

/** V2 route value (ctx.ui.router.current()); sessions carry the id directly
 * (V1's `params.sessionID` shape does not exist here). */
type V2Route = { type: "home" } | { type: "session"; sessionID: string };

/** Command registered in a V2 keymap layer. */
interface V2Command {
  id: string;
  title: string;
  group?: string;
  palette?: boolean;
  slash?: { name: string; aliases?: string[]; arguments?: boolean };
  run: (input?: string) => void | Promise<void>;
}

/** Structural slice of the opencode 2.x TUI plugin context (beta). Local by
 * design: the host provides the runtime module at load time. */
interface V2TuiContext {
  options?: Readonly<Record<string, unknown>>;
  app?: { version?: string };
  theme?: { text?: { muted?: string; default?: string } };
  ui: {
    slot: (input: {
      append: string;
      render: (input: { sessionID?: string }) => unknown;
    }) => (() => void) | void;
    dialog: {
      show: (render: () => unknown, onClose?: () => void) => void;
      set: (opts: { size?: "medium" | "large" | "xlarge" }) => void;
      clear: () => void;
      alert: (opts: { title: string; message: string }) => Promise<unknown>;
    };
    router: { current: () => V2Route | undefined };
  };
  keymap?: {
    layer: (
      factory: () => {
        mode: "global";
        priority: number;
        commands: V2Command[];
      },
    ) => unknown;
  };
  data?: {
    on: (
      type: string,
      handler: (event: unknown) => void,
    ) => (() => void) | void;
  };
}

const handoff = createHandoffStore();

// TUI-process diagnostics: the plugin logs go to opencode's files, but THIS
// module runs in the TUI process whose failures show no trace there — mirror
// the V1 module's own-log pattern (append-only, bounded) so failures are
// legible. Same file as V1: one TUI process runs one of the two modules.
const DEBUG_FILE = join(DEFAULT_HANDOFF_DIR, "tui-debug.log");
const debug = (...message: unknown[]) =>
  appendBoundedLog(
    DEBUG_FILE,
    `[${new Date().toISOString()}] [tui-v2] ${message.map(String).join(" ")}\n`,
  );

// the live slot is the only component that knows the active session; the
// dialogs reuse it so one opencode window can never render another session's
// stats (same guard as V1)
let activeSessionID: string | null = null;

// Handoff reads are throttled but never stale on purpose (V1 contract): each
// refresh waits its slot (~120 ms) and then reads FRESH — a TTL cache can
// swallow the final persist. Per-session: each read targets exactly one
// stats-<sessionID>.json.
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
  // display, and the file must be THIS session's
  return pickSessionFile(file, activeSessionID);
};

// /model consults the catalog; memoize the promise (TTL) so opening the
// dialog never races the CDN mirrors every time. Same helper as V1: one
// promise per window, failures degrade to null and are retried after the TTL.
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

const ZERO_SUMMARY: SessionSummary = {
  steps: 0,
  tokensOutTotal: 0,
  decodeMsTotal: 0,
  avgTps: 0,
  avgTtftMs: 0,
};

export function createV2TuiPlugin() {
  return {
    id: "opencode-ollama-cloud-tui",
    async setup(ctx: V2TuiContext): Promise<(() => void) | void> {
      debug("setup entry, version", String(ctx.app?.version ?? "?"));
      // assigned as soon as the teardown closure exists so the outer catch
      // can release partial registrations (timers, listeners)
      let dispose: (() => void) | null = null;
      try {
        const options = ctx.options ?? {};
        // knob: opt-out supported from BOTH module entries
        if (options.stats === "off") {
          debug("stats off — retiring before any registration");
          return;
        }
        // Same doors as the server entry: a configured catalogUrl replaces
        // the default mirrors for /model; only the literal "off" turns the
        // official rate off (pricingKnob).
        const catalogUrl =
          typeof options.catalogUrl === "string"
            ? options.catalogUrl
            : undefined;
        const pricingOn = pricingKnob(options.pricing) === "on";

        if (typeof ctx.ui?.slot !== "function") {
          debug("ui.slot API missing; stats UI retires silently");
          return;
        }
        const muted = (): string | undefined =>
          ctx.theme?.text?.muted ?? ctx.theme?.text?.default;

        // V2 route fallback: commands run outside a slot render, so the
        // current session comes from the router accessor. Anything missing or
        // foreign → null, never a guess (same contract as V1's resolver).
        const routeSession = (): string | null => {
          try {
            const current = ctx.ui.router?.current?.();
            if (
              current &&
              typeof current === "object" &&
              current.type === "session"
            ) {
              const sid = (current as { sessionID?: unknown }).sessionID;
              if (typeof sid === "string" && sid) return sid;
            }
          } catch {
            /* router is a convenience; the slot keeps the pointer */
          }
          return null;
        };
        // only a resolution that KNOWS the session may update the pointer
        const resolveSession = (): string | null => {
          const sid = routeSession();
          if (sid) activeSessionID = sid;
          return sid;
        };

        const [line, setLine] = createSignal<string>(formatLiveLine(null));
        // update badge (self-update effort): the server writes update.json
        // when it staged a newer release; the TUI shows it as a suffix on the
        // live line. Best-effort: the line survives without it.
        const [badge, setBadge] = createSignal<string>("");
        // /stats dialog body: a signal so the 1 s poll re-renders the open
        // dialog in place (V2 dialogs render JSX, not a string message)
        const [statsText, setStatsText] = createSignal<string>("");
        let lastLine: string | null = null;
        // whether a /stats dialog is currently open (cleared on close and
        // whenever another dialog of ours takes over): the 1 s poll updates
        // the signal only while it is open. /model is snapshot-only.
        let statsDialogOpen = false;
        let disposed = false;
        const unsubscribers: Array<() => void> = [];
        const catalogOnce = ttlMemo(() => loadCatalog({ catalogUrl }));

        const refreshBadge = async () => {
          try {
            const record = await readUpdateRecord();
            setBadge(record ? `↑ ${record.latest}` : "");
          } catch {
            /* the badge is decoration, never a failure */
          }
        };
        void refreshBadge();

        const refresh = async (sessionID?: string) => {
          try {
            // reads for the prop's session (falling back to the route, then
            // to the active one); null → sessionFile returns null → "—"
            const sid = sessionID ?? routeSession();
            if (sid) activeSessionID = sid;
            const file = await sessionFile(sid);
            const next = formatLiveLine(file?.summary ?? null);
            // one log line per actual CHANGE of the shown value; errors always
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
            debug(
              "refresh error:",
              error instanceof Error ? error.message : String(error),
            );
          }
        };

        // The /stats body is the same string at open and on every live
        // re-render: one computation, one model-attribution rule (the header
        // names the LAST model; the average spans model switches by design).
        const statsBody = async (): Promise<string> => {
          const file = await sessionFile(resolveSession());
          return formatStatsDialogBody(
            file?.summary ?? ZERO_SUMMARY,
            file?.steps ?? [],
            file?.steps[0]?.modelID ?? "—",
            Date.now(),
          );
        };

        const showStats = async (): Promise<void> => {
          try {
            setStatsText(await statsBody());
            try {
              ctx.ui.dialog.set({ size: "large" });
            } catch {
              /* sizing is cosmetic */
            }
            ctx.ui.dialog.show(
              () => (
                <box flexDirection="column">
                  <text fg={muted()}>/stats</text>
                  {statsText()
                    .split("\n")
                    .map((text) => (
                      <text>{text.length > 0 ? text : " "}</text>
                    ))}
                </box>
              ),
              () => {
                statsDialogOpen = false;
              },
            );
            // only after show succeeded: a throw here leaves no dialog to
            // refresh
            statsDialogOpen = true;
          } catch (error) {
            statsDialogOpen = false;
            debug(
              "stats dialog error:",
              error instanceof Error ? error.message : String(error),
            );
            try {
              ctx.ui.dialog.clear();
            } catch {
              /* already gone */
            }
          }
        };

        // Live /stats: while the dialog is open each poll tick recomputes the
        // body and updates the signal the render reads. Best-effort — a
        // failed tick leaves the dialog as-is and the next one retries.
        const refreshStatsDialog = async (): Promise<void> => {
          if (!statsDialogOpen) return;
          try {
            const body = await statsBody();
            // the read awaits ~120 ms: the dialog may have been closed or
            // replaced meanwhile, and re-renders must never resurrect it
            if (!statsDialogOpen) return;
            setStatsText(body);
          } catch (error) {
            debug(
              "stats dialog refresh error:",
              error instanceof Error ? error.message : String(error),
            );
          }
        };

        const showModel = async (): Promise<void> => {
          try {
            const file = await sessionFile(resolveSession());
            const modelID = file?.steps[0]?.modelID;
            let body: string;
            let title = "/model";
            if (!modelID) {
              body =
                "  No measured responses yet in this session —\n  run /model after a response";
            } else {
              let catalog: Catalog | null = null;
              try {
                catalog = await catalogOnce();
              } catch {
                catalog = null;
              }
              if (!catalog) {
                title = `/model · ${modelID} (catalog unavailable)`;
                body =
                  "  Card\n\n  Quantization      — (unavailable)\n\n  (model outside the catalog, nothing estimated)";
              } else {
                const model = catalog.models.find((m) => m.id === modelID);
                if (model) {
                  const card: ModelCard = {
                    id: model.id,
                    name: model.name,
                    family: model.family,
                    releaseDate: model.releaseDate,
                    quantization: model.quantization,
                    context: model.context,
                    maxOutput: model.maxOutput,
                    capabilities: model.capabilities,
                    pricing: model.cost ?? null,
                  };
                  body = formatModelCard(card, pricingOn);
                } else {
                  title = `/model · ${modelID} (not in catalog)`;
                  body =
                    "  Card\n\n  Quantization      — (unavailable)\n\n  (model outside the catalog, nothing estimated)";
                }
              }
            }
            // /model takes over whatever dialog was open — the /stats dialog
            // is gone, so the poll must not resurrect it over this card. Only
            // clear when OURS is open: never dismiss another plugin's dialog.
            if (statsDialogOpen) {
              statsDialogOpen = false;
              try {
                ctx.ui.dialog.clear();
              } catch {
                /* nothing open */
              }
            }
            try {
              ctx.ui.dialog.set({ size: "large" });
            } catch {
              /* sizing is cosmetic */
            }
            await ctx.ui.dialog.alert({ title, message: body });
          } catch (error) {
            debug(
              "model dialog error:",
              error instanceof Error ? error.message : String(error),
            );
            try {
              ctx.ui.dialog.clear();
            } catch {
              /* already gone */
            }
          }
        };

        // Live line in the prompt footer. `render` runs inside a Solid owner,
        // so the signals read below re-render in place (no node caching like
        // V1's slot dispatcher).
        let unregisterSlot: (() => void) | null = null;
        const unregister = ctx.ui.slot({
          append: "prompt.footer.status",
          render: (input) => {
            try {
              // only a render that KNOWS the session may update the pointer —
              // resolved from the slot input first, then from the router
              const sid = input?.sessionID ?? routeSession();
              if (sid) activeSessionID = sid;
              void refresh(sid ?? undefined);
              const b = badge();
              return (
                <text fg={muted()}>
                  {" "}
                  {line()}
                  {b ? ` ${b}` : ""}{" "}
                </text>
              );
            } catch (error) {
              debug(
                "slot render error:",
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              );
              return null;
            }
          },
        });
        if (typeof unregister === "function") unregisterSlot = unregister;
        debug("slot prompt.footer.status registered");

        // Housekeeping, once per TUI launch (same as V1): drop other
        // sessions' handoff files and anything older than a day. Best-effort
        // and awaited nowhere — registration never waits on it.
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

        // Keep the live line fresh: events for instant updates (the server
        // persists the handoff when the execution/step settles) and a 1 s
        // poll as the convergence floor — the V1 event-driven read lost the
        // race against the final persist, the poll cannot.
        try {
          const offSucceeded = ctx.data?.on?.(
            "session.execution.succeeded",
            () => void refresh(),
          );
          if (typeof offSucceeded === "function")
            unsubscribers.push(offSucceeded);
          const offStepEnded = ctx.data?.on?.(
            "session.step.ended",
            () => void refresh(),
          );
          if (typeof offStepEnded === "function")
            unsubscribers.push(offStepEnded);
        } catch {
          /* event bus unavailable: the poll still covers it */
        }
        const poll = setInterval(() => {
          void refresh();
          // live /stats: refresh the open dialog's body on the same floor
          void refreshStatsDialog();
        }, 1000);
        try {
          poll.unref?.();
        } catch {
          /* unref is Node/Bun-specific; fine to keep the interval un-unref'd */
        }
        // the record can land after this TUI mounted — slow floor, best-effort
        const badgePoll = setInterval(() => void refreshBadge(), 30000);
        try {
          badgePoll.unref?.();
        } catch {
          /* same as above */
        }

        // disposal: release everything this setup registered (slot, event
        // subs, timers, dialog-refresh state). Idempotent: the host may call
        // the returned cleanup AND Solid's owner cleanup.
        const cleanup = () => {
          if (disposed) return;
          disposed = true;
          try {
            for (const off of unsubscribers) {
              try {
                off();
              } catch {
                /* one failing unsubscribe must not stop the rest */
              }
            }
            try {
              unregisterSlot?.();
            } catch {
              /* the slot may already be gone */
            }
            try {
              unregisterCommands?.();
            } catch {
              /* the commands slot may already be gone */
            }
            clearInterval(poll);
            clearInterval(badgePoll);
            statsDialogOpen = false;
          } catch {
            /* silent-degradation contract: dispose never throws */
          }
        };
        dispose = cleanup;
        try {
          onCleanup(cleanup);
        } catch {
          /* setup may run outside a Solid owner; the return value still applies */
        }

        // /stats and /model commands. V2's keymap.layer needs the Keymap
        // provider, which only exists inside a rendered component — calling it
        // straight from setup throws "Keymap.Provider is missing" in the beta.
        // The `app` slot renders a null component whose body owns the layer.
        let unregisterCommands: (() => void) | null = null;
        const Commands = () => {
          try {
            if (typeof ctx.keymap?.layer === "function") {
              ctx.keymap.layer(() => ({
                mode: "global",
                priority: 10,
                commands: [
                  {
                    id: "opencode-ollama-cloud.stats",
                    title: "Stats",
                    group: "Ollama Cloud",
                    palette: true,
                    slash: { name: "stats" },
                    run() {
                      void showStats();
                    },
                  },
                  {
                    id: "opencode-ollama-cloud.model",
                    title: "Model card",
                    group: "Ollama Cloud",
                    palette: true,
                    slash: { name: "model" },
                    run() {
                      void showModel();
                    },
                  },
                ],
              }));
              debug("keymap layer registered");
            } else {
              debug(
                "keymap.layer API missing; /stats and /model retire silently",
              );
            }
          } catch (error) {
            debug(
              "keymap layer error:",
              error instanceof Error ? error.message : String(error),
            );
          }
          return null;
        };
        try {
          const unregister = ctx.ui.slot({
            append: "app",
            render: () => <Commands />,
          });
          if (typeof unregister === "function") unregisterCommands = unregister;
        } catch (error) {
          debug(
            "commands slot error:",
            error instanceof Error ? error.message : String(error),
          );
        }

        return cleanup;
      } catch (error) {
        // degradación silenciosa: stats UI down, provider/catalog untouched
        debug(
          "setup() threw:",
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        );
        console.warn(
          "[opencode-ollama-cloud/tui-v2] stats UI retired silently:",
          error instanceof Error ? error.message : error,
        );
        try {
          dispose?.();
        } catch {
          /* partial teardown must never throw either */
        }
      }
    },
  };
}
