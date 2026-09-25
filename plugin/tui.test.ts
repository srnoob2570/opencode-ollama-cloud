import { describe, expect, test } from "bun:test";
import tuiModule from "./tui.tsx";

type TuiV2Context = Parameters<typeof tuiModule.setup>[0];

// El contrato V2 del host es `{ id, setup }`; `tui` sigue existiendo para V1.
// Estas pruebas fijan las dos entradas y la degradación silenciosa de setup.
describe("V2 TUI module shape", () => {
  test("default export is { id, setup (V2), tui (V1) }", () => {
    expect(typeof tuiModule.id).toBe("string");
    expect(tuiModule.id.length).toBeGreaterThan(0);
    expect(typeof tuiModule.setup).toBe("function");
    expect(typeof tuiModule.tui).toBe("function");
  });
});

describe("setupV2Tui", () => {
  test("retires silently with stats=off", () => {
    expect(tuiModule.setup({ options: { stats: "off" } })).toBeUndefined();
  });

  test("retires silently when ui.slot is missing", () => {
    expect(tuiModule.setup({ ui: {} })).toBeUndefined();
  });

  test("claims session_prompt_right + app slots and returns dispose", () => {
    const claims: Array<{
      append?: string;
      render: (props?: { session_id?: string }) => unknown;
    }> = [];
    const ctx: TuiV2Context = {
      options: {},
      app: { version: "2.0.15-test" },
      theme: { text: { muted: "#888888" } },
      ui: {
        slot: (claim) => {
          claims.push(claim);
        },
        router: { current: () => ({ type: "home" }) },
        dialog: { show: () => {}, clear: () => {}, alert: async () => {} },
      },
      // el host real expone createLayer; el fake sólo comprueba que se invoca
      keymap: { layer: (factory) => factory() },
    };

    const dispose = tuiModule.setup(ctx);
    expect(typeof dispose).toBe("function");

    const targets = claims.map((claim) => claim.append);
    expect(targets).toContain("session_prompt_right");
    expect(targets).toContain("app");

    const live = claims.find(
      (claim) => claim.append === "session_prompt_right",
    );
    expect(live).toBeDefined();
    expect(() => live?.render({ session_id: "ses_test" })).not.toThrow();

    const appSlot = claims.find((claim) => claim.append === "app");
    expect(appSlot).toBeDefined();
    expect(() => appSlot?.render()).not.toThrow();

    expect(() => dispose?.()).not.toThrow();
    // dispose es idempotente
    expect(() => dispose?.()).not.toThrow();
  });
});
