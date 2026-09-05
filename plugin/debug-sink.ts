import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DebugSink } from "./capture.ts";
import { DEFAULT_HANDOFF_DIR } from "./handoff.ts";

// Split out of index.ts: the plugin entry module must export ONLY the plugin
// factory. opencode's legacy plugin loader calls every exported function of a
// plugin module as a plugin factory with (PluginInput, options) — this sink
// once received the PluginInput object as `dir` and crashed the whole plugin
// load before `default` ever ran (see the note in ./index.ts).

// Append-only, bounded log shared by the server's stats-debug.log and the
// TUI's tui-debug.log: one line per call, dropping the head past ~256 KB —
// the plugin processes are daemon-long, so an unbounded log would grow
// forever. Errors are swallowed: diagnostics must never break the plugin.
export const appendBoundedLog = (file: string, line: string): void => {
  try {
    appendFileSync(file, line);
    if (statSync(file).size > 256 * 1024) {
      const tail = readFileSync(file, "utf8").slice(-128 * 1024);
      writeFileSync(file, tail);
    }
  } catch {
    /* diagnostics must never break the plugin */
  }
};

// Claim instrumentation sink (statsDebug knob): appends one line per claim
// attempt to <handoffDir>/stats-debug.log. Default OFF.
export const createStatsDebugSink = (dir: string = DEFAULT_HANDOFF_DIR) => {
  const file = join(dir, "stats-debug.log");
  return (line: string): void =>
    appendBoundedLog(file, `[${new Date().toISOString()}] ${line}\n`);
};

// The knob itself: truthy → enabled, anything else (including absence) → OFF,
// i.e. no sink is ever built and no stats-debug.log byte is ever written.
export const statsDebugSinkFor = (value: unknown) =>
  value ? createStatsDebugSink() : undefined;
