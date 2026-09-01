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
  formatLiveLine,
  formatModelCard,
  formatStatsDialogBody,
  pickTuiFeatures,
  referencePricingActive,
  type ModelCard,
} from "./tui-display.ts";
import { createHandoffStore, type HandoffFile } from "./handoff.ts";
import { loadCatalog, type Catalog as CatalogModel2 } from "./catalog.ts";
import type { SessionSummary } from "./stats.ts";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DEFAULT_HANDOFF_DIR } from "./handoff.ts";
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
  event?: {
    on: (type: string, handler: (event: unknown) => void) => () => void;
  };
  theme: { current: { textMuted?: string; text?: string } };
  state?: { config?: { plugin?: unknown } };
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
// omo-slim's own-log pattern (append-only, bounded) so failures are legible.
const DEBUG_FILE = join(DEFAULT_HANDOFF_DIR, "tui-debug.log");
const debug = (...message: unknown[]) => {
  try {
    appendFileSync(
      DEBUG_FILE,
      `[${new Date().toISOString()}] ${message.map(String).join(" ")}\n`,
    );
    // bounded: drop the head when the log grows past ~256 KB
    const size = statSync(DEBUG_FILE).size;
    if (size > 256 * 1024) {
      const tail = readFileSync(DEBUG_FILE, "utf8").slice(-128 * 1024);
      writeFileSync(DEBUG_FILE, tail);
    }
  } catch {
    /* logging must never break rendering */
  }
};

// the live slot is the only component that knows the active session; dialogs
// reuse it so one opencode window can never render another session's stats
let activeSessionID: string | null = null;

// Handoff reads are throttled but never stale on purpose: each refresh waits
// its slot (~120 ms) and then reads FRESH — a TTL cache can swallow the final
// persist (the exact bug that froze the live line on dashes).
let lastReadAt = 0;
const readFresHandoff = async (): Promise<HandoffFile | null> => {
  const wait = Math.max(0, 120 - (Date.now() - lastReadAt));
  try {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return await handoff.read();
  } finally {
    lastReadAt = Date.now();
  }
};
const readHandoff = readFresHandoff;
const sessionFile = async (): Promise<HandoffFile | null> => {
  const file = await readFresHandoff();
  // the active session id is what the slot last saw; a transient render with
  // no session_id must NOT clobber it (that was the revert-to-empty bug)
  if (file && (!activeSessionID || file.sessionID === activeSessionID))
    return file;
  return null;
};

// /model consults the catalog; memoize the promise (TTL) so opening the
// dialog never races the CDN mirrors every time
let catalogCache: {
  at: number;
  promise: Promise<CatalogModel2 | null>;
} | null = null;
const catalogOnce = (): Promise<CatalogModel2 | null> => {
  if (!catalogCache || Date.now() - catalogCache.at > 60_000) {
    catalogCache = {
      at: Date.now(),
      promise: loadCatalog({}).catch(() => null),
    };
  }
  return catalogCache.promise;
};

const showStats = async (api: TuiLike): Promise<void> => {
  try {
    const file = await sessionFile();
    const body = formatStatsDialogBody(
      file?.summary ?? ZERO_SUMMARY,
      file?.steps ?? [],
      file?.steps[0]?.modelID ?? "—",
      Date.now(),
    );
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title: "/stats",
        message: body,
        onConfirm: () => api.ui.dialog.clear(),
      }),
    );
  } catch (error) {
    console.warn(
      "[opencode-ollama-cloud/tui] /stats failed silently:",
      error instanceof Error ? error.message : error,
    );
    api.ui.dialog.clear();
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
        const catalog = await catalogOnce();
        const model: CatalogModel2["models"][number] | undefined =
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
            pricing: model.pricing ?? null,
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
  async tui(api: TuiLike, options?: { stats?: string; pricing?: string }) {
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
      const features: { slots: boolean; keymap: boolean } =
        pickTuiFeatures(api);
      debug("features:", JSON.stringify(features));
      if (!features.slots) {
        debug("slots API missing; stats UI retires silently");
        return;
      }

      const [line, setLine] = createSignal<string>(formatLiveLine(null));
      let lastLine: string | null = null;
      const refresh = async (sessionID?: string) => {
        try {
          const file = await sessionFile();
          const next = formatLiveLine(file?.summary ?? null);
          // one log line per actual CHANGE of the shown value (idle+trailing
          // re-reads would spam otherwise); errors always log
          if (next !== lastLine) {
            debug(
              "line:",
              "active=",
              String(sessionID ?? activeSessionID ?? "none"),
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

      api.slots.register({
        order: 100,
        slots: {
          session_prompt_right: (
            _ctx: unknown,
            props: { session_id?: string },
          ) => {
            try {
              // only a render that KNOWS the session may update the pointer —
              // transient prop-less renders keep the last known session
              if (props?.session_id) activeSessionID = props.session_id;
              void refresh(props?.session_id);
              return <text fg={api.theme?.current?.textMuted}> {line()} </text>;
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
        },
      });
      debug("slot session_prompt_right registered");

      // Keep the live line fresh. Verified against opencode's source: the
      // server plugin hook is dispatched fire-and-forget while the TUI bus
      // delivers the same message.updated FIRST — every event-driven read
      // loses the race against the final persist. So: events for instant
      // updates, trailing re-reads after session.idle (emitted after
      // completed+DB-persist; our hook's file write lags it by ms), and a
      // 1 s poll as the convergence floor.
      try {
        api.event?.on?.("message.updated", () => void refresh());
        api.event?.on?.("session.idle", () => {
          void refresh();
          setTimeout(() => void refresh(), 200);
          setTimeout(() => void refresh(), 700);
        });
      } catch {
        /* event bus unavailable: the poll still covers it */
      }
      const poll = setInterval(() => void refresh(), 1000);
      try {
        poll.unref?.();
      } catch {
        /* unref is Node/Bun-specific; fine to keep the interval un-unref'd */
      }

      if (features.keymap) {
        // the pricing knob lives on the server entry (README) — scan config
        const pricingOn = referencePricingActive(api.state?.config, {
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
