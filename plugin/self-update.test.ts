import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setSep,
  compareSemver,
  decideUpdate,
  fetchLatestVersion,
  findInstalledVersion,
  isPinnedVersionSuffix,
  isUpdateRecord,
  parseModuleOrigin,
  PACKAGE_NAME,
  readUpdateRecord,
  runSelfUpdate,
} from "./self-update.ts";

const PKG_DIR = "/@srnoob2570/opencode-ollama-cloud/plugin/self-update.ts";

describe("parseModuleOrigin (montaje npm vs dev del propio módulo)", () => {
  test("ruta npm dentro del packages root: extrae wrapper y sufijo", () => {
    const root = "/home/u/.cache/opencode/packages";
    expect(
      parseModuleOrigin(
        root +
          "/@srnoob2570/opencode-ollama-cloud@latest/node_modules" +
          PKG_DIR,
        root,
      ),
    ).toEqual({
      source: "npm",
      wrapperRoot: root + "/@srnoob2570/opencode-ollama-cloud@latest",
      versionSuffix: "latest",
    });
    expect(
      parseModuleOrigin(
        root + "/opencode-ollama-cloud/node_modules" + PKG_DIR,
        root,
      ),
    ).toEqual({
      source: "npm",
      wrapperRoot: root + "/opencode-ollama-cloud",
      versionSuffix: null,
    });
    const pinned = parseModuleOrigin(
      root + "/opencode-ollama-cloud@0.1.8/node_modules" + PKG_DIR,
      root,
    );
    expect(pinned?.source === "npm" ? pinned.versionSuffix : null).toBe(
      "0.1.8",
    );
  });

  test("ruta del repo (sin node_modules intermedio) es dev", () => {
    expect(parseModuleOrigin("/repo/plugin/self-update.ts")).toEqual({
      source: "dev",
    });
  });

  test("node_modules fuera del packages root no es actualizable (npm link)", () => {
    expect(
      parseModuleOrigin(
        "/srv/link/node_modules/@srnoob2570/opencode-ollama-cloud/plugin/self-update.ts",
      ),
    ).toBeNull();
  });

  test("sufijo exacto vs rango: el basename decide con el último @", () => {
    const root = "/h/.cache/opencode/packages";
    const ranged = parseModuleOrigin(
      root + "/pkg@^1.2.0/node_modules" + PKG_DIR,
      root,
    );
    expect(ranged?.source).toBe("npm");
    expect(ranged?.source === "npm" ? ranged.versionSuffix : null).toBe(
      "^1.2.0",
    );
  });
});

describe("isPinnedVersionSuffix (spec fijado nunca se auto-actualiza)", () => {
  test("bare, latest y rangos son actualizables", () => {
    expect(isPinnedVersionSuffix(null)).toBe(false);
    expect(isPinnedVersionSuffix("latest")).toBe(false);
    expect(isPinnedVersionSuffix("^1.2.0")).toBe(false);
    expect(isPinnedVersionSuffix("~1.2")).toBe(false);
    expect(isPinnedVersionSuffix("*")).toBe(false);
  });
  test("versión exacta (con o sin prerelease) está fijada", () => {
    expect(isPinnedVersionSuffix("0.1.8")).toBe(true);
    expect(isPinnedVersionSuffix("0.1.8-beta.1")).toBe(true);
  });
});

describe("compareSemver (orden estricto de versiones)", () => {
  test("comparaciones básicas", () => {
    expect(compareSemver("0.1.9", "0.1.8")).toBe(1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.1.8", "0.1.8")).toBe(0);
    expect(compareSemver("v0.1.8", "0.1.8")).toBe(0);
    expect(compareSemver("0.1.7", "0.1.8")).toBe(-1);
  });
  test("entradas inválidas → null (y el prerelease no gana su base)", () => {
    expect(compareSemver("abc", "0.1.0")).toBeNull();
    expect(compareSemver("", "0.1.0")).toBeNull();
  });
});

describe("decideUpdate (política de auto-actualización)", () => {
  const ok = {
    installed: "0.1.8",
    latest: "0.1.9",
    pinned: false,
    isNpm: true,
  };
  test("npm + versión nueva → update", () => {
    expect(decideUpdate(ok)).toEqual({ action: "update", latest: "0.1.9" });
  });
  test("igual, vieja o inválida → none", () => {
    expect(decideUpdate({ ...ok, latest: "0.1.8" })).toEqual({
      action: "none",
    });
    expect(decideUpdate({ ...ok, latest: "0.1.7" })).toEqual({
      action: "none",
    });
    expect(decideUpdate({ ...ok, latest: "not-a-version" })).toEqual({
      action: "none",
    });
  });
  test("pinned o no-npm nunca actualizan", () => {
    expect(decideUpdate({ ...ok, pinned: true })).toEqual({ action: "none" });
    expect(decideUpdate({ ...ok, isNpm: false })).toEqual({ action: "none" });
  });
  test("datos faltantes → none", () => {
    expect(decideUpdate({ ...ok, installed: null })).toEqual({
      action: "none",
    });
    expect(decideUpdate({ ...ok, latest: null })).toEqual({ action: "none" });
  });
});

describe("isUpdateRecord (contrato de update.json)", () => {
  test("acepta el registro válido", () => {
    expect(
      isUpdateRecord({
        installed: "0.1.8",
        latest: "0.1.9",
        seenAt: "2026-09-05T10:00:00Z",
      }),
    ).toBe(true);
  });
  test("rechaza formas rotas", () => {
    expect(isUpdateRecord(null)).toBe(false);
    expect(isUpdateRecord({ installed: "0.1.8" })).toBe(false);
    expect(
      isUpdateRecord({
        installed: "",
        latest: "0.1.9",
        seenAt: "2026-09-05T10:00:00Z",
      }),
    ).toBe(false);
    expect(
      isUpdateRecord({
        installed: "0.1.8",
        latest: "0.1.9",
        seenAt: "not-a-date",
      }),
    ).toBe(false);
  });
});

describe("findInstalledVersion (walk-up al package.json propio)", () => {
  test("encuentra la versión subiendo hasta el package.json del paquete", async () => {
    const base = await mkdtemp(join(tmpdir(), "ococ-selfupd-"));
    try {
      const pkgDir = join(base, "pkg", "plugin");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(base, "pkg", "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "9.9.9" }),
      );
      await writeFile(join(pkgDir, "self-update.ts"), "// stub");
      const version = await findInstalledVersion(
        join(pkgDir, "self-update.ts"),
      );
      expect(version).toBe("9.9.9");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  test("package.json ajeno en el camino no corta el walk-up", async () => {
    const base = await mkdtemp(join(tmpdir(), "ococ-selfupd-"));
    try {
      const pkgDir = join(base, "pkg", "plugin");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(base, "package.json"),
        JSON.stringify({ name: "otro" }),
      );
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "1.0.0" }),
      );
      expect(await findInstalledVersion(join(pkgDir, "self-update.ts"))).toBe(
        "1.0.0",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  test("sin package.json propio → null", async () => {
    const base = await mkdtemp(join(tmpdir(), "ococ-selfupd-"));
    try {
      expect(
        await findInstalledVersion(join(base, "self-update.ts")),
      ).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("fetchLatestVersion (sondeo del registry, silencioso)", () => {
  test("res.ok + version string → versión", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ version: "0.2.0" }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await fetchLatestVersion(1000, fake)).toBe("0.2.0");
  });
  test("error de red / no-ok → null, nunca throw", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion(1000, failing)).toBeNull();
    const notOk = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion(1000, notOk)).toBeNull();
  });
});

describe("runSelfUpdate (flujo completo de arranque)", () => {
  const PKG_URL = "/pkg/node_modules" + PKG_DIR;

  test("dev: limpia update.json y no toca nada más", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ococ-selfupd-"));
    const file = join(dir, "update.json");
    await writeFile(
      file,
      '{"installed":"a","latest":"b","seenAt":"2026-09-05T10:00:00Z"}',
    );
    try {
      const out = await runSelfUpdate({
        moduleUrl: "/repo/plugin/self-update.ts",
        updateFile: file,
      });
      expect(out).toBe("skipped-dev");
      expect(await readUpdateRecord(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("npm sin versión instalada → skipped-no-version", async () => {
    __setSep("/");
    const dir = await mkdtemp(join(tmpdir(), "ococ-selfupd-"));
    try {
      const url =
        join(dir, "packages", "opencode-ollama-cloud@latest") +
        "/node_modules" +
        PKG_URL;
      const out = await runSelfUpdate({
        moduleUrl: url,
        packagesRoot: join(dir, "packages"),
        updateFile: join(dir, "update.json"),
      });
      expect(out).toBe("skipped-no-version");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wrapper de otro mundo (npm link) → skipped-unknown-root", async () => {
    const out = await runSelfUpdate({
      moduleUrl: "/srv/link/node_modules" + PKG_URL,
      updateFile: "/nonexistent/update.json",
    });
    expect(out).toBe("skipped-unknown-root");
  });
});
