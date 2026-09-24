// Host-generation awareness for the deprecation effort (docs/research/
// soporte-v1-v2.md). Detection turned out to be unnecessary for behavior:
// the dual entry decides it — opencode v1 runs the `server` factory, v2 runs
// `setup`, and the TUI module only ever loads on v1 (2.0.x has no reachable
// third-party TUI loading path). Presence inside those code paths IS the
// generation, so this module only carries the V1 deprecation notice.
//
// Owner decision: SILENT — one line in the plugin's own debug dir
// (~/.cache/opencode-ollama-cloud/deprecation.log), never a toast, dialog or
// console.warn, and silenceable with the `deprecation: "off"` plugin option
// (same opt-out convention as pricing/stats/tui).
import { mkdirSync } from "node:fs";
import { appendBoundedLog } from "./debug-sink.ts";
import { DEFAULT_HANDOFF_DIR } from "./handoff.ts";
import { dirname, join } from "node:path";

const DEPRECATION_LOG = join(DEFAULT_HANDOFF_DIR, "deprecation.log");

// Test seam: the real target lives in the user's home, so tests must be able
// to redirect it to a tmpdir before the first logDeprecatedV1 call.
let deprecationLog = DEPRECATION_LOG;

/** Knob: only the literal "off" silences the notice (mirror of pricingKnob). */
export const deprecationKnob = (value: unknown): "off" | "on" =>
  value === "off" ? "off" : "on";

// Once per process: the factory and the TUI entry can both fire on the same
// v1 host, and the notice is per-boot, not per-entry.
let deprecationLogged = false;

/**
 * One silent log line on V1 hosts. Never throws, never shows anything on
 * screen, no-op when silenced or already logged. Runs on every v1 boot so
 * the notice is discoverable in the plugin's own diagnostics directory.
 */
export function logDeprecatedV1(knob: unknown): void {
  try {
    if (deprecationLogged || deprecationKnob(knob) === "off") return;
    deprecationLogged = true;
    // This runs BEFORE anything else in the plugin creates the handoff dir
    // (first boot of a fresh install: the dir does not exist yet and
    // appendBoundedLog would swallow the ENOENT silently) — so the notice
    // creates its own target. mkdir first, append after, both best-effort.
    mkdirSync(dirname(deprecationLog), { recursive: true });
    appendBoundedLog(
      deprecationLog,
      `[${new Date().toISOString()}] opencode 1.x (V1) host: support for opencode V1 is deprecated and will be removed in a future release of this plugin. Migrate to opencode 2.x. Silence this notice with the \`deprecation: "off"\` plugin option.\n`,
    );
  } catch {
    /* diagnostics must never break the plugin */
  }
}

/** @internal test seam: reset the once-guard between cases. */
export function __resetDeprecationForTests(): void {
  deprecationLogged = false;
}

/** @internal test seam: point the log at a tmpdir — never the real home. */
export function __setDeprecationLogForTests(path: string): void {
  deprecationLog = path;
}
