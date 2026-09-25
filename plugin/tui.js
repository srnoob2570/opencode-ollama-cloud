// @bun
// plugin/tui.tsx
import { createSignal } from "solid-js";
import {
  formatLiveLine,
  formatStatsDialogBody,
  pickSessionFile,
  pickTuiFeatures,
  resolveSessionID
} from "./tui-display.ts";
import {
  createHandoffStore,
  DEFAULT_HANDOFF_DIR
} from "./handoff.ts";
import { readUpdateRecord } from "./self-update.ts";
import { logDeprecatedV1 } from "./version.ts";
import { appendBoundedLog } from "./debug-sink.ts";
import { join } from "path";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var handoff = createHandoffStore();
var ZERO_SUMMARY = {
  steps: 0,
  tokensOutTotal: 0,
  decodeMsTotal: 0,
  avgTps: 0,
  avgTtftMs: 0
};
var DEBUG_FILE = join(DEFAULT_HANDOFF_DIR, "tui-debug.log");
var debug = (...message) => appendBoundedLog(DEBUG_FILE, `[${new Date().toISOString()}] ${message.map(String).join(" ")}
`);
var activeSessionID = null;
var statsDialogOpen = false;
var lastReadAt = 0;
var readFreshHandoff = async (sessionID) => {
  const wait = Math.max(0, 120 - (Date.now() - lastReadAt));
  try {
    if (wait > 0)
      await new Promise((resolve) => setTimeout(resolve, wait));
    return await handoff.read(sessionID);
  } finally {
    lastReadAt = Date.now();
  }
};
var sessionFile = async (sessionID) => {
  const sid = sessionID ?? activeSessionID;
  if (!sid)
    return null;
  const file = await readFreshHandoff(sid);
  return pickSessionFile(file, activeSessionID);
};
var logToOpencode = (api, ...message) => {
  try {
    if (typeof api.log?.warn === "function")
      api.log.warn(...message);
    else if (typeof api.log?.error === "function")
      api.log.error(...message);
  } catch {}
};
var statsBody = async () => {
  const file = await sessionFile();
  return formatStatsDialogBody(file?.summary ?? ZERO_SUMMARY, file?.steps ?? [], file?.steps[0]?.modelID ?? "\u2014", Date.now());
};
var renderStatsDialog = (api, body) => {
  api.ui.dialog.replace(() => api.ui.DialogAlert({
    title: "/stats",
    message: body,
    onConfirm: () => {
      statsDialogOpen = false;
      api.ui.dialog.clear();
    }
  }));
  statsDialogOpen = true;
};
var showStats = async (api) => {
  try {
    renderStatsDialog(api, await statsBody());
  } catch (error) {
    statsDialogOpen = false;
    console.warn("[opencode-ollama-cloud/tui] /stats failed silently:", error instanceof Error ? error.message : error);
    api.ui.dialog.clear();
  }
};
var refreshStatsDialog = async (api) => {
  if (!statsDialogOpen)
    return;
  try {
    const body = await statsBody();
    if (!statsDialogOpen)
      return;
    renderStatsDialog(api, body);
  } catch (error) {
    debug("stats dialog refresh error:", error instanceof Error ? error.message : String(error));
  }
};
var mutedFg = (theme) => {
  if (typeof theme?.textMuted === "string")
    return theme.textMuted;
  const nested = theme?.text?.muted;
  return typeof nested === "string" ? nested : undefined;
};
function setupV2Tui(ctx) {
  debug("v2 setup entry, version", String(ctx?.app?.version ?? "?"));
  try {
    if (ctx?.options?.stats === "off") {
      debug("stats off \u2014 retiring before any registration");
      return;
    }
    const slot = ctx?.ui?.slot;
    if (typeof slot !== "function") {
      debug("v2 ui.slot missing; stats UI retires silently");
      return;
    }
    const routeCurrent = () => ctx?.ui?.router?.current?.();
    const [line, setLine] = createSignal(formatLiveLine(null));
    const [badge, setBadge] = createSignal("");
    const refreshBadge = async () => {
      try {
        const record = await readUpdateRecord();
        setBadge(record ? `\u2191 ${record.latest}` : "");
      } catch {}
    };
    refreshBadge();
    let lastLine = null;
    const refresh = async (sessionID) => {
      try {
        const sid = sessionID ?? resolveSessionID(undefined, { current: routeCurrent() });
        if (sid)
          activeSessionID = sid;
        const file = await sessionFile(sid);
        const next = formatLiveLine(file?.summary ?? null);
        if (next !== lastLine) {
          debug("v2 line:", "active=", String(sid ?? "none"), "->", next);
          lastLine = next;
        }
        setLine(next);
      } catch (error) {
        debug("v2 refresh error:", error instanceof Error ? error.message : String(error));
      }
    };
    slot({
      append: "session_prompt_right",
      render: (props) => {
        try {
          const sid = resolveSessionID(props?.session_id, {
            current: routeCurrent()
          });
          if (sid)
            activeSessionID = sid;
          refresh(sid ?? undefined);
          const b = badge();
          return /* @__PURE__ */ jsxs("text", {
            fg: mutedFg(ctx?.theme),
            children: [
              " ",
              line(),
              b ? ` ${b}` : "",
              " "
            ]
          });
        } catch (error) {
          const msg = error instanceof Error ? error.stack ?? error.message : String(error);
          debug("v2 slot render error:", msg);
          return null;
        }
      }
    });
    debug("v2 slot session_prompt_right registered");
    const [dialogBody, setDialogBody] = createSignal("");
    let dialogOpen = false;
    const openDialog = () => {
      const dialog = ctx?.ui?.dialog;
      if (typeof dialog?.show === "function") {
        dialog.show(() => /* @__PURE__ */ jsx("text", {
          children: dialogBody()
        }), () => {
          dialogOpen = false;
        });
        dialogOpen = true;
      } else if (typeof dialog?.alert === "function") {
        dialog.alert({ title: "/stats", message: dialogBody() });
      }
    };
    const showStats2 = async () => {
      try {
        setDialogBody(await statsBody());
        openDialog();
      } catch (error) {
        dialogOpen = false;
        debug("v2 /stats failed silently:", error instanceof Error ? error.message : String(error));
        try {
          ctx?.ui?.dialog?.clear?.();
        } catch {}
      }
    };
    const refreshDialog = async () => {
      if (!dialogOpen)
        return;
      try {
        const body = await statsBody();
        if (dialogOpen)
          setDialogBody(body);
      } catch (error) {
        debug("v2 stats dialog refresh error:", error instanceof Error ? error.message : String(error));
      }
    };
    const poll = setInterval(() => {
      refresh();
      refreshDialog();
    }, 1000);
    try {
      poll.unref?.();
    } catch {}
    const badgePoll = setInterval(() => void refreshBadge(), 30000);
    try {
      badgePoll.unref?.();
    } catch {}
    let disposed = false;
    const dispose = () => {
      if (disposed)
        return;
      disposed = true;
      try {
        clearInterval(poll);
        clearInterval(badgePoll);
        dialogOpen = false;
      } catch {}
    };
    slot({
      append: "app",
      render: () => {
        const layer = ctx?.keymap?.layer;
        if (typeof layer !== "function")
          return null;
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
                  showStats2();
                }
              }
            ]
          }));
        } catch (error) {
          debug("v2 keymap layer error:", error instanceof Error ? error.message : String(error));
          return null;
        }
      }
    });
    return dispose;
  } catch (error) {
    debug("v2 setup threw:", error instanceof Error ? error.stack ?? error.message : String(error));
    return;
  }
}
var tui_default = {
  id: "opencode-ollama-cloud-tui",
  setup: setupV2Tui,
  async tui(api, options) {
    debug("tui module entry, version", String(api.app?.version ?? "?"));
    logDeprecatedV1(options?.deprecation);
    try {
      if (options?.stats === "off") {
        debug("stats off \u2014 retiring before any registration");
        return;
      }
      const features = pickTuiFeatures(api);
      debug("features:", JSON.stringify(features));
      if (!features.slots) {
        debug("slots API missing; stats UI retires silently");
        return;
      }
      const [line, setLine] = createSignal(formatLiveLine(null));
      const [badge, setBadge] = createSignal("");
      const refreshBadge = async () => {
        try {
          const record = await readUpdateRecord();
          setBadge(record ? `\u2191 ${record.latest}` : "");
        } catch {}
      };
      refreshBadge();
      let lastLine = null;
      const routeSession = () => resolveSessionID(undefined, api.route);
      const refresh = async (sessionID) => {
        try {
          const sid = sessionID ?? routeSession();
          if (sid)
            activeSessionID = sid;
          const file = await sessionFile(sid);
          const next = formatLiveLine(file?.summary ?? null);
          if (next !== lastLine) {
            debug("line:", "active=", String(sid ?? "none"), "steps=", String(file?.summary?.steps ?? -1), "->", next);
            lastLine = next;
          }
          setLine(next);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          debug("refresh error:", msg);
          logToOpencode(api, "[opencode-ollama-cloud/tui] stats refresh failed:", msg);
        }
      };
      api.slots.register({
        order: 100,
        slots: {
          session_prompt_right: (_ctx, props) => {
            try {
              const sid = resolveSessionID(props?.session_id, api.route);
              if (sid)
                activeSessionID = sid;
              refresh(sid ?? undefined);
              const b = badge();
              return /* @__PURE__ */ jsxs("text", {
                fg: api.theme?.current?.textMuted,
                children: [
                  " ",
                  line(),
                  b ? ` ${b}` : "",
                  " "
                ]
              });
            } catch (error) {
              const msg = error instanceof Error ? error.stack ?? error.message : String(error);
              debug("slot render error:", msg);
              logToOpencode(api, "[opencode-ollama-cloud/tui] stats slot render failed:", msg);
              return null;
            }
          }
        }
      });
      debug("slot session_prompt_right registered");
      try {
        handoff.cleanup(null, 24 * 60 * 60 * 1000).then((deleted) => debug("handoff cleanup deleted", String(deleted), "file(s)")).catch((error) => debug("handoff cleanup error:", error instanceof Error ? error.message : String(error)));
      } catch {}
      const unsubscribers = [];
      try {
        const offUpdated = api.event?.on?.("message.updated", () => void refresh());
        if (typeof offUpdated === "function")
          unsubscribers.push(offUpdated);
        const offIdle = api.event?.on?.("session.idle", () => {
          refresh();
          setTimeout(() => void refresh(), 200);
          setTimeout(() => void refresh(), 700);
        });
        if (typeof offIdle === "function")
          unsubscribers.push(offIdle);
      } catch {}
      const poll = setInterval(() => {
        refresh();
        refreshStatsDialog(api);
      }, 1000);
      try {
        poll.unref?.();
      } catch {}
      const badgePoll = setInterval(() => void refreshBadge(), 30000);
      try {
        badgePoll.unref?.();
      } catch {}
      let disposed = false;
      const dispose = () => {
        if (disposed)
          return;
        disposed = true;
        try {
          for (const off of unsubscribers) {
            try {
              off();
            } catch {}
          }
          clearInterval(poll);
          clearInterval(badgePoll);
          statsDialogOpen = false;
        } catch {}
      };
      try {
        if (typeof api.lifecycle?.onDispose === "function")
          api.lifecycle.onDispose(dispose);
      } catch {}
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
                showStats(api);
              }
            }
          ]
        });
      }
    } catch (error) {
      debug("tui() threw:", error instanceof Error ? error.stack ?? error.message : String(error));
      console.warn("[opencode-ollama-cloud/tui] stats UI retired silently:", error instanceof Error ? error.message : error);
    }
  }
};
export {
  tui_default as default
};
