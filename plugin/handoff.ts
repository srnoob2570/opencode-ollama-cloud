// Server → TUI handoff for live stats (spec Pieza 1.4). The server plugin
// module rewrites the file after each update; the TUI module only reads.
// Same directory/pattern as the catalog cache. Never touches opencode's own
// store — read-only on opencode's data, append-only on our own cache.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionSummary, StepMeasurement } from "./stats.ts"

export const DEFAULT_HANDOFF_DIR = join(homedir(), ".cache", "opencode-ollama-cloud")
export const HANDOFF_FILE_NAME = "stats.json"

/** Snapshot of one session's stats, newest-first steps (capped by the writer). */
export interface HandoffFile {
  sessionID: string
  generatedAt: string
  summary: SessionSummary
  steps: StepMeasurement[]
}

export const MAX_HANDOFF_STEPS = 50

export interface HandoffStore {
  write(file: HandoffFile): Promise<void>
  read(): Promise<HandoffFile | null>
}

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
  typeof (s as StepMeasurement).source === "string"

export function isHandoffFile(value: unknown): value is HandoffFile {
  if (typeof value !== "object" || value === null) return false
  const f = value as HandoffFile
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
  )
}

export const createHandoffStore = (dir: string = DEFAULT_HANDOFF_DIR): HandoffStore => {
  const path = join(dir, HANDOFF_FILE_NAME)
  return {
    async write(file) {
      try {
        // write temp + rename: the TUI module may read at any moment, so the
        // file must never be observed half-written.
        await mkdir(dir, { recursive: true })
        const tmp = join(dir, `${HANDOFF_FILE_NAME}.${Date.now()}.tmp`)
        await writeFile(tmp, JSON.stringify(file))
        await rename(tmp, path)
      } catch {
        /* handoff is best-effort; the TUI renders stale/empty gracefully */
      }
    },
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
        return isHandoffFile(parsed) ? parsed : null
      } catch {
        return null
      }
    },
  }
}