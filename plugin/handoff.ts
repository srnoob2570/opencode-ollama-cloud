// Server → TUI handoff for live stats (spec Pieza 1.4). One file per session
// (stats-<sessionID>.json — D3): the server plugin rewrites its own session's
// file after each update; the TUI module only reads the file of the session it
// renders, so two opencode windows can never clobber each other's snapshot.
// Same directory/pattern as the catalog cache. Never touches opencode's own
// store — read-only on opencode's data, append-only on our own cache.
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSummary, StepMeasurement } from "./stats.ts";

export const DEFAULT_HANDOFF_DIR = join(
  homedir(),
  ".cache",
  "opencode-ollama-cloud",
);

const HANDOFF_PREFIX = "stats-";
const HANDOFF_SUFFIX = ".json";
/** Retired v1 layout: one shared slot every TUI read raced over. */
const LEGACY_HANDOFF_FILE = "stats.json";

/** Snapshot of one session's stats, newest-first steps (capped by the writer). */
export interface HandoffFile {
  sessionID: string;
  generatedAt: string;
  summary: SessionSummary;
  steps: StepMeasurement[];
}

export const MAX_HANDOFF_STEPS = 50;

export interface HandoffStore {
  /** <dir>/stats-<sessionID>.json for the given session. */
  pathFor(sessionID: string): string;
  read(sessionID: string): Promise<HandoffFile | null>;
  write(file: HandoffFile): Promise<void>;
  /**
   * Delete stats-*.json files not belonging to `keepSessionID` (when non-null)
   * or older than `maxAgeMs`, plus the legacy single-slot stats.json. Returns
   * the number of files deleted.
   */
  cleanup(keepSessionID: string | null, maxAgeMs: number): Promise<number>;
}

// opencode sessionIDs are [A-Za-z0-9_-]; anything else is replaced so a
// hostile or corrupt id can never turn the filename into a path traversal.
const sanitizeSessionID = (sessionID: string): string => {
  const clean = sessionID.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean.length > 0 ? clean : "unknown";
};

// Shape guard mirrors isCatalog's style: tolerant of extra fields, strict on
// the ones consumers rely on. Corrupt/hand-edited files are ignored, never
// fatal (the handoff is best-effort by contract).
const isStep = (s: unknown): s is StepMeasurement =>
  typeof s === "object" &&
  s !== null &&
  typeof (s as StepMeasurement).sessionID === "string" &&
  typeof (s as StepMeasurement).modelID === "string" &&
  typeof (s as StepMeasurement).ttftMs === "number" &&
  typeof (s as StepMeasurement).tokensOut === "number" &&
  typeof (s as StepMeasurement).decodeMs === "number" &&
  typeof (s as StepMeasurement).source === "string";

export function isHandoffFile(value: unknown): value is HandoffFile {
  if (typeof value !== "object" || value === null) return false;
  const f = value as HandoffFile;
  return (
    typeof f.sessionID === "string" &&
    typeof f.generatedAt === "string" &&
    typeof f.summary === "object" &&
    f.summary !== null &&
    typeof f.summary.avgTps === "number" &&
    typeof f.summary.avgTtftMs === "number" &&
    typeof f.summary.steps === "number" &&
    Array.isArray(f.steps) &&
    f.steps.every(isStep)
  );
}

export const createHandoffStore = (
  dir: string = DEFAULT_HANDOFF_DIR,
): HandoffStore => {
  const pathFor = (sessionID: string): string =>
    join(
      dir,
      `${HANDOFF_PREFIX}${sanitizeSessionID(sessionID)}${HANDOFF_SUFFIX}`,
    );
  return {
    pathFor,
    async write(file) {
      try {
        // write temp + rename: the TUI module may read at any moment, so the
        // file must never be observed half-written.
        await mkdir(dir, { recursive: true });
        // the .tmp suffix keeps half-written files out of cleanup's *.json glob
        const tmp = join(
          dir,
          `${HANDOFF_PREFIX}${sanitizeSessionID(file.sessionID)}${HANDOFF_SUFFIX}.${Date.now()}.tmp`,
        );
        await writeFile(tmp, JSON.stringify(file));
        await rename(tmp, pathFor(file.sessionID));
      } catch {
        /* handoff is best-effort; the TUI renders stale/empty gracefully */
      }
    },
    async read(sessionID) {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(pathFor(sessionID), "utf8"),
        );
        // a valid file carrying another session's id under this name is stale
        // garbage from a sanitize collision — never serve it
        if (!isHandoffFile(parsed) || parsed.sessionID !== sessionID)
          return null;
        return parsed;
      } catch {
        return null;
      }
    },
    async cleanup(keepSessionID, maxAgeMs) {
      let deleted = 0;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return 0; // no handoff dir yet: nothing to clean
      }
      const cutoff = Date.now() - maxAgeMs;
      for (const name of entries) {
        // per-file try: one unreadable entry must not stop the sweep
        try {
          const fullPath = join(dir, name);
          if (name === LEGACY_HANDOFF_FILE) {
            // the v1 single slot is always obsolete under the v2 layout
            await rm(fullPath, { force: true });
            deleted += 1;
            continue;
          }
          if (
            !name.startsWith(HANDOFF_PREFIX) ||
            !name.endsWith(HANDOFF_SUFFIX)
          )
            continue;
          // content sessionID when parseable; the filename id covers corrupt
          // files (sanitization makes the filename a faithful stand-in)
          let sid: string | null = null;
          try {
            const parsed: unknown = JSON.parse(
              await readFile(fullPath, "utf8"),
            );
            if (isHandoffFile(parsed)) sid = parsed.sessionID;
          } catch {
            /* fall through to the filename-derived id */
          }
          const filenameID = name.slice(
            HANDOFF_PREFIX.length,
            name.length - HANDOFF_SUFFIX.length,
          );
          const keepID =
            keepSessionID == null ? null : sanitizeSessionID(keepSessionID);
          const matchesKeep = sid === keepSessionID || filenameID === keepID;
          // another session's file goes NOW; ours (or an unknown one) only on age
          if (keepID != null && !matchesKeep) {
            await rm(fullPath, { force: true });
            deleted += 1;
            continue;
          }
          const info = await stat(fullPath);
          if (info.mtimeMs < cutoff) {
            await rm(fullPath, { force: true });
            deleted += 1;
          }
        } catch {
          /* keep sweeping */
        }
      }
      return deleted;
    },
  };
};
