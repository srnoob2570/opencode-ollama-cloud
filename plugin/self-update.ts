// Self-update plumbing for npm installs (the @tarquinen/opencode-dcp
// precedent): version detection by walking up to our own package.json,
// semver compare, a single registry probe per boot, eviction of the
// ~/.cache/opencode/packages/<spec> wrapper so the next Npm.add reinstalls
// latest, and the update.json record the TUI badge reads. Dev checkouts
// (repo path, no /node_modules/ between packages root and the module) are a
// no-op: there is nothing npm can update there. Pure helpers are unit
// tested; runSelfUpdate() is fire-and-forget by contract and never throws
// to its caller.

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

export const PACKAGE_NAME = "@srnoob2570/opencode-ollama-cloud";

const PACKAGES_ROOT = join(homedir(), ".cache", "opencode", "packages");
const CACHE_DIR = join(homedir(), ".cache", "opencode-ollama-cloud");
const UPDATE_FILE = join(CACHE_DIR, "update.json");
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export type ModuleOrigin =
  | { source: "npm"; wrapperRoot: string; versionSuffix: string | null }
  | { source: "dev" };

/**
 * Where is this module running from? The npm path inside opencode's package
 * cache contains /node_modules/ exactly once (wrapper/node_modules/<pkg>/…);
 * the wrapper root under ~/.cache/opencode/packages is what Npm.add checks
 * before reinstalling, so deleting it defeats the early-return. Anything
 * else — the repo checkout, npm link, a foreign cache — is "dev" and opts
 * out; `null` means the path is unusable for self-update decisions.
 */
export function parseModuleOrigin(
  moduleUrl: string,
  packagesRoot: string = PACKAGES_ROOT,
): ModuleOrigin | null {
  const path = moduleUrl.startsWith("file://")
    ? fileURLToPath(moduleUrl)
    : moduleUrl;
  const marker = `${sep()}node_modules${sep()}`;
  const idx = path.indexOf(marker);
  if (idx < 0) return { source: "dev" };
  const wrapperRoot = path.slice(0, idx);
  if (!wrapperRoot.startsWith(packagesRoot + sep())) return null;
  // Wrapper dir names carry the spec's version suffix when there is one:
  // "<name>@latest", "<name>@1.2.3", or a bare "<name>" (scoped packages
  // nest one level, so the leaf basename still ends with the suffix).
  const leaf = basename(wrapperRoot);
  const at = leaf.lastIndexOf("@");
  return {
    source: "npm",
    wrapperRoot,
    versionSuffix: at > 0 ? leaf.slice(at + 1) : null,
  };
}

// Keep it test-overridable without importing node:platform.
let _sep = "/";
function sep(): string {
  return _sep;
}
/** @internal test seam */
export function __setSep(value: string): void {
  _sep = value;
}

/**
 * Exact pinned versions ("@1.2.3") must never be auto-updated — the user
 * asked for that exact build. Bare specs, "@latest" and semver ranges
 * ("^1.2.0", "~1", "*") are updatable, mirroring dcp's isAutoUpdatableSpec.
 */
export function isPinnedVersionSuffix(suffix: string | null): boolean {
  if (suffix === null || suffix === "latest") return false;
  return /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(suffix);
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 1 if a > b, -1 if a < b, 0 if equal, null if either is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++)
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

export type UpdateDecision =
  { action: "update"; latest: string } | { action: "none" };

export function decideUpdate(input: {
  installed: string | null;
  latest: string | null;
  pinned: boolean;
  isNpm: boolean;
}): UpdateDecision {
  const { installed, latest, pinned, isNpm } = input;
  if (!isNpm || pinned || !installed || !latest) return { action: "none" };
  const cmp = compareSemver(latest, installed);
  return cmp !== null && cmp > 0
    ? { action: "update", latest }
    : { action: "none" };
}

export interface UpdateRecord {
  installed: string;
  latest: string;
  seenAt: string;
}

export function isUpdateRecord(value: unknown): value is UpdateRecord {
  const r = value as Partial<UpdateRecord> | null | undefined;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.installed === "string" &&
    r.installed.length > 0 &&
    typeof r.latest === "string" &&
    r.latest.length > 0 &&
    typeof r.seenAt === "string" &&
    r.seenAt.length > 0 &&
    !Number.isNaN(Date.parse(r.seenAt))
  );
}

/**
 * Walk up from a module file to the nearest package.json that is ours and
 * return its version (the dcp findPackageDir pattern; works in dev too,
 * where the caller is gated off before acting on it).
 */
export async function findInstalledVersion(
  moduleUrl: string,
  readFileFn: typeof readFile = readFile,
): Promise<string | null> {
  let path = moduleUrl.startsWith("file://")
    ? fileURLToPath(moduleUrl)
    : moduleUrl;
  for (let depth = 0; depth < 40; depth++) {
    const dir = dirname(path);
    try {
      const pkg = JSON.parse(
        await readFileFn(join(dir, "package.json"), "utf8"),
      );
      if (pkg?.name === PACKAGE_NAME)
        return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      /* not ours / missing — keep walking */
    }
    if (dir === dirname(dir)) return null;
    path = dir;
  }
  return null;
}

/** One registry probe per boot; any failure is silent (best-effort). */
export async function fetchLatestVersion(
  timeoutMs = 10_000,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export async function readUpdateRecord(
  file: string = UPDATE_FILE,
): Promise<UpdateRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isUpdateRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeUpdateRecord(
  record: UpdateRecord,
  file: string = UPDATE_FILE,
): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record));
  } catch {
    /* best-effort */
  }
}

export async function clearUpdateRecord(
  file: string = UPDATE_FILE,
): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch {
    /* best-effort */
  }
}

// Structural slice of opencode's SDK client we need for the toast — never
// imported, so a missing/changed surface degrades to "no toast", not a crash.
export interface ToastClient {
  tui?: {
    showToast?: (options: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }) => Promise<unknown>;
  };
}

export type SelfUpdateOutcome =
  | "updated"
  | "current"
  | "skipped-dev"
  | "skipped-unknown-root"
  | "skipped-no-version"
  | "failed";

/**
 * The whole boot-time flow: detect origin → read installed version → probe
 * the registry → decide → evict the wrapper + record + toast, or clean up a
 * stale update.json when running==latest. Never throws.
 */
export async function runSelfUpdate(args: {
  moduleUrl: string;
  client?: unknown;
  toastDelayMs?: number;
  now?: () => Date;
  packagesRoot?: string;
  updateFile?: string;
}): Promise<SelfUpdateOutcome> {
  try {
    const updateFile = args.updateFile ?? UPDATE_FILE;
    const origin = parseModuleOrigin(args.moduleUrl, args.packagesRoot);
    if (origin === null) return "skipped-unknown-root";
    if (origin.source === "dev") {
      await clearUpdateRecord(updateFile);
      return "skipped-dev";
    }
    const installed = await findInstalledVersion(args.moduleUrl);
    if (!installed) return "skipped-no-version";
    const latest = await fetchLatestVersion();
    const pinned = isPinnedVersionSuffix(origin.versionSuffix);
    const decision = decideUpdate({
      installed,
      latest,
      pinned,
      isNpm: true,
    });
    if (decision.action !== "update") {
      await clearUpdateRecord(updateFile);
      return "current";
    }
    // Evict while running: both server and TUI modules are already in
    // memory, and the next Npm.add reinstall latest (dcp's exact trick).
    await rm(origin.wrapperRoot, { recursive: true, force: true });
    await writeUpdateRecord(
      {
        installed,
        latest: decision.latest,
        seenAt: (args.now?.() ?? new Date()).toISOString(),
      },
      updateFile,
    );
    // The TUI may still be booting when the server finishes its own boot;
    // give it a moment, then fire-and-forget (headless servers just fail
    // the HTTP call and swallow it).
    setTimeout(() => {
      const client = args.client as ToastClient | undefined;
      client?.tui
        ?.showToast?.({
          body: {
            title: "opencode-ollama-cloud",
            message: `Updated ${PACKAGE_NAME} from ${installed} to ${decision.latest}. Restart opencode to finish.`,
            variant: "info",
            duration: 7000,
          },
        })
        .catch(() => {});
    }, args.toastDelayMs ?? 5000);
    return "updated";
  } catch {
    return "failed";
  }
}
