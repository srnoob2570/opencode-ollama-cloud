import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureKnob,
  ensureTuiPlugin,
  patchTuiConfigText,
  specEntryMatches,
} from "./ensure-tui.ts";
import { PACKAGE_NAME, parseModuleOrigin } from "./self-update.ts";

const SPEC = PACKAGE_NAME;
const NPM_URL =
  "/tmp/ococ/packages/@srnoob2570/opencode-ollama-cloud@latest/node_modules" +
  "/@srnoob2570/opencode-ollama-cloud/plugin/index.ts";
const PKG_ROOT = "/tmp/ococ/packages";

describe("ensureKnob (opt-in estricto)", () => {
  test('solo "ensure" activa; el resto (incluso undefined) queda off', () => {
    expect(ensureKnob("ensure")).toBe("ensure");
    expect(ensureKnob(undefined)).toBe("off");
    expect(ensureKnob("off")).toBe("off");
    expect(ensureKnob("yes")).toBe("off");
    expect(ensureKnob(true)).toBe("off");
  });
});

describe("specEntryMatches (idempotencia por nombre de paquete)", () => {
  test("spec exacto y con tag coinciden", () => {
    expect(specEntryMatches(SPEC)).toBe(true);
    expect(specEntryMatches(`${SPEC}@latest`)).toBe(true);
  });
  test("ruta directa (install dev) coincide por substring", () => {
    expect(specEntryMatches("/repo/opencode-ollama-cloud/plugin/tui.tsx")).toBe(
      true,
    );
  });
  test("tupla: mira el primer elemento", () => {
    expect(specEntryMatches([SPEC, { stats: "off" }])).toBe(true);
    expect(
      specEntryMatches(["/repo/opencode-ollama-cloud/plugin/tui.tsx", {}]),
    ).toBe(true);
    expect(specEntryMatches(["@other/pkg", {}])).toBe(false);
  });
  test("otros paquetes y no-strings no coinciden", () => {
    expect(specEntryMatches("@other/pkg")).toBe(false);
    expect(specEntryMatches(42)).toBe(false);
    expect(specEntryMatches(null)).toBe(false);
    expect(specEntryMatches([42, {}])).toBe(false);
  });
});

describe("patchTuiConfigText (edición quirúrgica que preserva JSONC)", () => {
  test("sin clave plugin: la añade formateada y conserva comentarios", () => {
    const patch = patchTuiConfigText(
      `{\n  // mis ajustes\n  "mouse": true\n}\n`,
      SPEC,
    );
    expect(patch.changed).toBe(true);
    expect(patch.reason).toBeNull();
    expect(patch.text).toBe(
      `{\n  // mis ajustes\n  "mouse": true,\n  "plugin": [\n    ${JSON.stringify(SPEC)}\n  ]\n}\n`,
    );
  });
  test("array con tupla y ruta: añade al final sin tocar lo existente", () => {
    const original = `{\n  "plugin": [\n    ["@other/pkg", { "stats": "off" }],\n    "/abs/repo/plugin/tui.tsx"\n  ],\n  "mouse": true\n}\n`;
    const patch = patchTuiConfigText(original, SPEC);
    expect(patch.changed).toBe(true);
    expect(patch.reason).toBeNull();
    expect(patch.text).toBe(
      `{\n  "plugin": [\n    ["@other/pkg", { "stats": "off" }],\n    "/abs/repo/plugin/tui.tsx",\n    ${JSON.stringify(SPEC)}\n  ],\n  "mouse": true\n}\n`,
    );
  });
  test("array vacío: lo rellena", () => {
    const patch = patchTuiConfigText(`{\n  "plugin": []\n}\n`, SPEC);
    expect(patch.changed).toBe(true);
    expect(patch.text).toBe(
      `{\n  "plugin": [\n    ${JSON.stringify(SPEC)}\n  ]\n}\n`,
    );
  });
  test("ya presente (spec exacto, con tag, tupla): no cambia nada", () => {
    for (const text of [
      `{\n  "plugin": ["${SPEC}"]\n}\n`,
      `{\n  "plugin": ["${SPEC}@latest"]\n}\n`,
      `{\n  "plugin": [["${SPEC}", { "stats": "off" }]]\n}\n`,
      `{\n  "plugin": ["/repo/opencode-ollama-cloud/plugin/tui.tsx"]\n}\n`,
    ]) {
      const patch = patchTuiConfigText(text, SPEC);
      expect(patch.changed).toBe(false);
      expect(patch.reason).toBe("present");
      expect(patch.text).toBe(text);
    }
  });
  test("plugin no-array y documento no-objeto: se niega", () => {
    expect(patchTuiConfigText(`{ "plugin": "x" }\n`, SPEC).reason).toBe(
      "plugin-not-array",
    );
    expect(patchTuiConfigText(`[1, 2]\n`, SPEC).reason).toBe("not-object");
    expect(patchTuiConfigText(`{ "plugin": }`, SPEC).reason).toBe("not-object");
  });
  test("tui.jsonc con comentarios: parchea igual", () => {
    const patch = patchTuiConfigText(
      `{\n  "diff_style": "auto" // elegido por el usuario\n}\n`,
      SPEC,
    );
    expect(patch.changed).toBe(true);
    expect(patch.text).toContain(`// elegido por el usuario`);
    expect(patch.text).toContain(JSON.stringify(SPEC));
  });
});

describe("parseModuleOrigin (puerta npm/dev del ensure)", () => {
  test("instalación npm dentro del wrapper cacheado", () => {
    expect(parseModuleOrigin(NPM_URL, PKG_ROOT)).toEqual({
      source: "npm",
      wrapperRoot: `${PKG_ROOT}/@srnoob2570/opencode-ollama-cloud@latest`,
      versionSuffix: "latest",
    });
  });
});

describe("ensureTuiPlugin (orquestador del registro TUI)", () => {
  const cleanup = async (dir: string) => {
    await rm(dir, { recursive: true, force: true });
  };
  const npmOpts = (extra: Record<string, unknown> = {}) => ({
    moduleUrl: NPM_URL,
    packagesRoot: PKG_ROOT,
    ...extra,
  });

  test("dev (ruta del repo) y npm link no escriben nada", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      expect(
        await ensureTuiPlugin({ moduleUrl: "/repo/plugin/index.ts", home }),
      ).toBe("skipped-dev");
      expect(
        await ensureTuiPlugin({
          moduleUrl: "/other/node_modules/@other/pkg/plugin/index.ts",
          packagesRoot: PKG_ROOT,
          home,
        }),
      ).toBe("skipped-dev");
      expect(
        await stat(join(home, ".config/opencode/tui.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await cleanup(home);
    }
  });

  test("sin tui.json previo: crea el global desde plantilla", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      expect(await ensureTuiPlugin(npmOpts({ home }))).toBe("created");
      const text = await readFile(
        join(home, ".config/opencode/tui.json"),
        "utf8",
      );
      const parsed = JSON.parse(text) as { plugin?: string[] };
      expect(parsed.plugin).toEqual([SPEC]);
      expect(text).toContain("https://opencode.ai/tui.json");
    } finally {
      await cleanup(home);
    }
  });

  test("tui.json existente sin plugin: parchea, respalda y preserva el resto", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      const target = join(home, ".config/opencode/tui.json");
      await mkdir(join(home, ".config/opencode"), { recursive: true });
      const original = `{\n  "$schema": "https://opencode.ai/tui.json",\n  // ajustes\n  "mouse": true\n}\n`;
      await writeFile(target, original);
      expect(await ensureTuiPlugin(npmOpts({ home }))).toBe("ensured");
      const text = await readFile(target, "utf8");
      expect(text).toContain(JSON.stringify(SPEC));
      expect(text).toContain("// ajustes");
      expect(await readFile(`${target}.bak`, "utf8")).toBe(original);
    } finally {
      await cleanup(home);
    }
  });

  test("ya registrado: outcome present y archivo intacto (sin backup)", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      const target = join(home, ".config/opencode/tui.json");
      await mkdir(join(home, ".config/opencode"), { recursive: true });
      const original = `{\n  "plugin": ["/repo/opencode-ollama-cloud/plugin/tui.tsx"]\n}\n`;
      await writeFile(target, original);
      expect(await ensureTuiPlugin(npmOpts({ home }))).toBe("present");
      expect(await readFile(target, "utf8")).toBe(original);
      expect(
        await stat(`${target}.bak`).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await cleanup(home);
    }
  });

  test("OPENCODE_TUI_CONFIG tiene precedencia (parchea ese archivo)", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      const envFile = join(home, "tui-proyecto.json");
      await writeFile(envFile, `{\n  "mouse": true\n}\n`);
      expect(
        await ensureTuiPlugin(
          npmOpts({ home, env: { OPENCODE_TUI_CONFIG: envFile } }),
        ),
      ).toBe("ensured");
      expect(await readFile(envFile, "utf8")).toContain(JSON.stringify(SPEC));
      expect(
        await stat(join(home, ".config/opencode/tui.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await cleanup(home);
    }
  });

  test("OPENCODE_TUI_CONFIG apuntando a archivo inexistente: se abstiene", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      expect(
        await ensureTuiPlugin(
          npmOpts({
            home,
            env: { OPENCODE_TUI_CONFIG: join(home, "missing.json") },
          }),
        ),
      ).toBe("skipped-env-missing");
    } finally {
      await cleanup(home);
    }
  });

  test("plugin no-array: skipped-shape, sin escritura", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      const target = join(home, ".config/opencode/tui.json");
      await mkdir(join(home, ".config/opencode"), { recursive: true });
      const original = `{\n  "plugin": "roto"\n}\n`;
      await writeFile(target, original);
      expect(await ensureTuiPlugin(npmOpts({ home }))).toBe("skipped-shape");
      expect(await readFile(target, "utf8")).toBe(original);
    } finally {
      await cleanup(home);
    }
  });

  test("acepta rutas con ~ en OPENCODE_TUI_CONFIG", async () => {
    const home = await mkdtemp(join(tmpdir(), "ococ-ensure-"));
    try {
      const envFile = join(home, "tui.json");
      await writeFile(envFile, `{\n  "mouse": true\n}\n`);
      expect(
        await ensureTuiPlugin(
          npmOpts({ home, env: { OPENCODE_TUI_CONFIG: "~/tui.json" } }),
        ),
      ).toBe("ensured");
      expect(await readFile(envFile, "utf8")).toContain(JSON.stringify(SPEC));
    } finally {
      await cleanup(home);
    }
  });
});
