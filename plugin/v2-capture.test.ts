import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV2StatsCapture } from "./v2-capture.ts";
import type { V2Event, V2ServerContext } from "./v2-types.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

const waitForAsync = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error("waitForAsync timed out");
    await tick();
  }
};

/** Fake V2 server context: drains a fixed event list and reports a parentID. */
const fakeContext = (
  events: V2Event[],
  parentID: string | null = null,
  directory = "C:/proj",
): V2ServerContext =>
  ({
    location: { directory },
    session: {
      get: async () => ({ id: "s-root", parentID }),
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      }),
    },
  }) as unknown as V2ServerContext;

const stepStarted = (
  messageID: string,
  created = 1_000,
  sessionID = "s-root",
  model: { providerID: string; id: string } = {
    providerID: "ollama-cloud",
    id: "glm-5.3",
  },
): V2Event => ({
  type: "session.step.started",
  created,
  data: { sessionID, assistantMessageID: messageID, model },
});

const delta = (
  messageID: string,
  created: number,
  type = "session.text.delta",
): V2Event => ({
  type,
  created,
  data: { sessionID: "s-root", assistantMessageID: messageID, delta: "x" },
});

const stepEnded = (
  messageID: string,
  created: number,
  output: number,
): V2Event => ({
  type: "session.step.ended",
  created,
  data: {
    sessionID: "s-root",
    assistantMessageID: messageID,
    tokens: { output },
  },
});

describe("createV2StatsCapture (event route)", () => {
  test("step lifecycle: TTFT from step start, decode first→last delta, usage tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      const ctx = fakeContext([
        stepStarted("msg_1", 1_000),
        delta("msg_1", 1_150),
        delta("msg_1", 1_300),
        stepEnded("msg_1", 1_400, 20),
      ]);
      await capture.attach(ctx);
      await waitForAsync(
        () => capture.collectors.get("s-root")?.summary().steps === 1,
      );
      await waitForAsync(
        async () => (await capture.store.read("s-root")) !== null,
      );

      const step = capture.collectors.get("s-root")?.recent(1)[0];
      expect(step?.ttftMs).toBe(150);
      expect(step?.decodeMs).toBe(150);
      expect(step?.tokensOut).toBe(20);
      expect(step?.source).toBe("wire");
      expect(step?.providerID).toBe("ollama-cloud");
      expect(step?.modelID).toBe("glm-5.3");

      const file = await capture.store.read("s-root");
      expect(file?.summary.steps).toBe(1);
      expect(file?.steps[0].ts).toBe(1_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a single stream signal is labelled wire-nostream (V1 '(direct)' tag)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      await capture.attach(
        fakeContext([
          stepStarted("msg_1", 1_000),
          delta("msg_1", 1_100),
          stepEnded("msg_1", 1_200, 5),
        ]),
      );
      await waitForAsync(
        () => capture.collectors.get("s-root")?.summary().steps === 1,
      );
      const step = capture.collectors.get("s-root")?.recent(1)[0];
      expect(step?.source).toBe("wire-nostream");
      expect(step?.decodeMs).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reasoning and tool-input deltas anchor the stream window too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      await capture.attach(
        fakeContext([
          stepStarted("msg_1", 1_000),
          delta("msg_1", 1_120, "session.reasoning.delta"),
          delta("msg_1", 1_200, "session.tool.input.delta"),
          stepEnded("msg_1", 1_300, 7),
        ]),
      );
      await waitForAsync(
        () => capture.collectors.get("s-root")?.summary().steps === 1,
      );
      const step = capture.collectors.get("s-root")?.recent(1)[0];
      expect(step?.ttftMs).toBe(120);
      expect(step?.decodeMs).toBe(80);
      expect(step?.source).toBe("wire");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a step without output tokens is dropped (not a step)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      await capture.attach(
        fakeContext([
          stepStarted("msg_1", 1_000),
          delta("msg_1", 1_100),
          stepEnded("msg_1", 1_200, 0),
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(capture.collectors.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("subagent sessions are excluded by parentID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      await capture.attach(
        fakeContext(
          [
            stepStarted("msg_1", 1_000),
            delta("msg_1", 1_100),
            stepEnded("msg_1", 1_200, 9),
          ],
          "ses_parent",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(capture.collectors.size).toBe(0);
      expect(capture.parents.get("s-root")).toBe("ses_parent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("events without a created timestamp fall back to the injected clock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      let clock = 5_000;
      const capture = createV2StatsCapture({
        now: () => clock,
        handoffDir: dir,
      });
      const noTime = (event: V2Event): V2Event => ({
        ...event,
        created: undefined,
      });
      await capture.attach(
        fakeContext([
          noTime(stepStarted("msg_1")),
          noTime(delta("msg_1", 0)),
          noTime(stepEnded("msg_1", 0, 3)),
        ]),
      );
      await waitForAsync(
        () => capture.collectors.get("s-root")?.summary().steps === 1,
      );
      const step = capture.collectors.get("s-root")?.recent(1)[0];
      expect(step?.ts).toBe(5_000);
      expect(step?.tokensOut).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("statsDebug sink receives one line per recorded step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const lines: string[] = [];
      const capture = createV2StatsCapture({
        now: () => 0,
        handoffDir: dir,
        debugSink: (line) => lines.push(line),
      });
      await capture.attach(
        fakeContext([
          stepStarted("msg_1", 1_000),
          delta("msg_1", 1_100),
          stepEnded("msg_1", 1_200, 4),
        ]),
      );
      await waitForAsync(() => lines.length === 1);
      expect(lines[0]).toContain("v2 step session=s-root");
      expect(lines[0]).toContain("tokensOut=4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("events from another location are ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      const foreign = (event: V2Event): V2Event => ({
        ...event,
        location: { directory: "C:/elsewhere" },
      });
      await capture.attach(
        fakeContext(
          [
            foreign(stepStarted("msg_1", 1_000)),
            foreign(delta("msg_1", 1_100)),
            foreign(stepEnded("msg_1", 1_200, 9)),
          ],
          null,
          "C:/proj",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(capture.collectors.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dispose aborts the subscription and resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ollama-cloud-v2-"));
    try {
      const capture = createV2StatsCapture({ now: () => 0, handoffDir: dir });
      const ctx = {
        session: { get: async () => ({ parentID: null }) },
        event: {
          subscribe: (options?: { signal?: AbortSignal }) => ({
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else
                  options?.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
            },
          }),
        },
      } as unknown as V2ServerContext;
      const registrations = await capture.attach(ctx);
      expect(registrations.length).toBe(1);
      await registrations[0].dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
