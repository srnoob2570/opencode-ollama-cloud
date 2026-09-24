import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetDeprecationForTests,
  __setDeprecationLogForTests,
  deprecationKnob,
  logDeprecatedV1,
} from "./version.ts";

// Las pruebas jamás tocan el home real: el log se redirige a un tmpdir antes
// del primer logDeprecatedV1 y el tmpdir se borra al terminar.
let logDir: string;
let logFile: string;

beforeAll(async () => {
  logDir = await mkdtemp(join(tmpdir(), "occ-deprecation-"));
  logFile = join(logDir, "deprecation.log");
  __setDeprecationLogForTests(logFile);
});

afterAll(async () => {
  await rm(logDir, { recursive: true, force: true });
});

describe("deprecationKnob", () => {
  test('solo el literal "off" silencia (espejo de pricingKnob)', () => {
    expect(deprecationKnob("off")).toBe("off");
    expect(deprecationKnob(undefined)).toBe("on");
    expect(deprecationKnob("on")).toBe("on");
    expect(deprecationKnob(true)).toBe("on");
  });
});

describe("logDeprecatedV1", () => {
  test("una línea por proceso — la segunda llamada no duplica", async () => {
    await rm(logFile, { force: true });
    __resetDeprecationForTests();
    logDeprecatedV1(undefined);
    logDeprecatedV1(undefined);
    const text = await readFile(logFile, "utf8");
    expect(text).toContain("opencode 1.x (V1) host");
    expect(text).toContain('`deprecation: "off"`');
    // una sola línea de aviso por proceso
    expect(text.trim().split("\n").length).toBe(1);
  });

  test('deprecation: "off" — ni un byte escrito', async () => {
    await rm(logFile, { force: true });
    __resetDeprecationForTests();
    logDeprecatedV1("off");
    await expect(stat(logFile)).rejects.toThrow();
  });

  test("nunca lanza (diagnóstico no puede romper el plugin)", () => {
    expect(() => logDeprecatedV1(undefined)).not.toThrow();
  });
});
