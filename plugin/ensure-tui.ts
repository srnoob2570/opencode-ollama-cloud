import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import { PACKAGE_NAME, parseModuleOrigin } from "./self-update.ts";

// Opt-in TUI auto-registration (option `tui: "ensure"` on the server entry).
// The TUI host (opencode ≥ 1.18) only reads its plugin list from tui.json, and
// nothing upstream writes that key for an npm install, so a bare install
// leaves the stats UI dead until the user edits tui.json by hand. With the
// knob on, the SERVER entry (which always loads) registers the TUI entry too,
// patching the tui.json opencode will actually read:
//   1. $OPENCODE_TUI_CONFIG (path to a file) when set — it shadows the global;
//   2. else ~/.config/opencode/tui.json, then tui.jsonc (first that exists);
//   3. else the global tui.json is created from a minimal template.
// The patch is surgical and idempotent: comments survive, existing entries
// (including option tuples like ["…", { "stats": "off" }]) are never touched,
// and the spec is only appended when this package is not listed yet. Changes
// take effect on the next TUI launch (opencode reads tui.json once at boot).

export type EnsureOutcome =
  | "ensured"
  | "created"
  | "present"
  | "skipped-dev"
  | "skipped-env-missing"
  | "skipped-shape"
  | "failed";

/** Knob: anything other than "ensure" means off (default — no tui.json writes). */
export const ensureKnob = (value: unknown): "off" | "ensure" =>
  value === "ensure" ? "ensure" : "off";

/**
 * Does a plugin-array entry refer to this package? Strings may be the bare npm
 * spec, a tagged one (`…@latest`) or a direct path (dev installs point at the
 * repo, which carries no npm scope), so equality is not enough — the unscoped
 * package name is the unique mark shared by every form. Tuple entries
 * (["spec", options]) are matched on their first element only.
 */
const UNQUALIFIED_NAME = PACKAGE_NAME.split("/").pop() as string;
export const specEntryMatches = (
  entry: unknown,
  spec = PACKAGE_NAME,
): boolean => {
  const first = Array.isArray(entry) ? (entry as unknown[])[0] : entry;
  if (typeof first !== "string") return false;
  return first === spec || first.includes(UNQUALIFIED_NAME);
};

export interface PatchResult {
  changed: boolean;
  text: string;
  /** null → nothing to report; a reason means the patch was intentionally refused. */
  reason: "present" | "not-object" | "plugin-not-array" | null;
}

const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true };
const SPEC_LITERAL = JSON.stringify(PACKAGE_NAME);

/**
 * Pure text→text patcher for a tui.json[.c] document. Preserves every byte
 * outside the inserted region (comments, key order, option tuples). Returns
 * changed:false with a reason when nothing should be written.
 */
export const patchTuiConfigText = (
  text: string,
  spec = PACKAGE_NAME,
): PatchResult => {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors);
  if (!tree || errors.length > 0)
    return { changed: false, text, reason: "not-object" };
  if (tree.type !== "object")
    return { changed: false, text, reason: "not-object" };

  const pluginNode = findNodeAtLocation(tree, ["plugin"]);

  // No plugin key yet: add it as a one-element array (jsonc-parser keeps the
  // rest of the document intact and formats the insert).
  if (!pluginNode) {
    const edits = modify(text, ["plugin"], [spec], {
      formattingOptions: FORMATTING,
    });
    return { changed: true, text: applyEdits(text, edits), reason: null };
  }

  if (pluginNode.type !== "array")
    return { changed: false, text, reason: "plugin-not-array" };

  // AST nodes expose scalars as .value, tuples as an array node — the tuple's
  // own .value is undefined, so unwrap its first element before matching.
  for (const child of pluginNode.children ?? []) {
    const value =
      child.type === "array" ? child.children?.[0]?.value : child.value;
    if (specEntryMatches(value, spec))
      return { changed: false, text, reason: "present" };
  }

  // Append at the end of the existing array; isArrayInsertion inserts a new
  // item at that index instead of overwriting (verified: index == length
  // appends, commas and indentation come out right, tuples stay untouched).
  const edits = modify(
    text,
    ["plugin", pluginNode.children?.length ?? 0],
    spec,
    { formattingOptions: FORMATTING, isArrayInsertion: true },
  );
  return { changed: true, text: applyEdits(text, edits), reason: null };
};

const TEMPLATE = `{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [${SPEC_LITERAL}]
}
`;

const expandTilde = (path: string, home: string): string =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? join(home, path.slice(2))
      : path;

export interface EnsureOptions {
  moduleUrl: string;
  spec?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Test seam: npm wrapper cache root (defaults to the real one). */
  packagesRoot?: string;
}

/**
 * Orchestrator: never throws, one shot per server boot. Only npm installs
 * act (a repo checkout is a dev install the owner manages by hand — same
 * gate as the self-update check). Returns what happened for logging/tests.
 */
export const ensureTuiPlugin = async (
  opts: EnsureOptions,
): Promise<EnsureOutcome> => {
  try {
    const origin = parseModuleOrigin(opts.moduleUrl, opts.packagesRoot);
    if (origin?.source !== "npm") return "skipped-dev";

    const spec = opts.spec ?? PACKAGE_NAME;
    const env = opts.env ?? process.env;
    const home = opts.home ?? homedir();
    const { readFile, writeFile, stat, rename } =
      await import("node:fs/promises");

    const opencodeDir = join(home, ".config", "opencode");
    const globalJson = join(opencodeDir, "tui.json");
    const globalJsonc = join(opencodeDir, "tui.jsonc");

    // Pick the file opencode will actually read, creating the global one
    // only when no layer exists yet (mirrors upstream's migrateTuiConfig).
    let target: string | null = null;
    const envSpec = env.OPENCODE_TUI_CONFIG;
    if (typeof envSpec === "string" && envSpec.trim() !== "") {
      const envPath = expandTilde(envSpec.trim(), home);
      target = (await stat(envPath).then(
        () => true,
        () => false,
      ))
        ? envPath
        : null;
      if (!target) return "skipped-env-missing";
    } else {
      for (const candidate of [globalJson, globalJsonc]) {
        if (
          await stat(candidate).then(
            () => true,
            () => false,
          )
        ) {
          target = candidate;
          break;
        }
      }
    }

    if (!target) {
      await mkdirWrite(globalJson, TEMPLATE);
      return "created";
    }

    // One retry if the file changed under us between read and write (we have
    // no lock; opencode's own patcher holds one — mtime check limits the harm).
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = (await stat(target)).mtimeMs;
      const text = await readFile(target, "utf8");
      const patch = patchTuiConfigText(text, spec);
      if (patch.reason === "present") return "present";
      if (patch.reason) return "skipped-shape";
      if (!patch.changed) return "failed";
      await sleep(1);
      if ((await stat(target)).mtimeMs !== before) continue;

      await writeFile(`${target}.bak`, text); // rollback copy; abort if unusable
      const tmp = `${target}.tmp-${Date.now().toString(36)}`;
      await writeFile(tmp, patch.text);
      await rename(tmp, target);
      return "ensured";
    }
    return "failed";
  } catch {
    return "failed";
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mkdirWrite(path: string, content: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}
