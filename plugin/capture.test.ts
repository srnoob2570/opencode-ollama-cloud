import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStatsCapture } from "./capture.ts"
import { isHandoffFile } from "./handoff.ts"

const tempDir = () => mkdtemp(join(tmpdir(), "stats-handoff-"))

// Synthetic ollama.com SSE: deltas, then the final usage chunk (opencode
// always requests include_usage), then [DONE].
const sseResponse = (chunks: string[]) => {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((r) => setTimeout(r, chunk === chunks[chunks.length - 1] ? 5 : 2))
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

const sseBody = (completionTokens: number) => [
  `data: {"id":"x","choices":[{"delta":{"content":"h"}}]}`,
  `\n\ndata: {"id":"x","choices":[{"delta":{"content":"i"}}]}\n`,
  `\ndata: {"id":"x","choices":[],"usage":{"prompt_tokens":68,"completion_tokens":${completionTokens},"total_tokens":${completionTokens + 68}}}\n`,
  `\ndata: [DONE]\n`,
]

const wireRequest = (headers: Record<string, string> = {}) =>
  new Request("https://ollama.com/v1/chat/completions", { method: "POST", headers })

const ROOT_SESSION_EVENT = { type: "session.created", properties: { info: { id: "s-root", parentID: null } } }
const ASSISTANT_UPDATE = (over: Record<string, unknown> = {}) => ({
  type: "message.updated",
  properties: {
    info: {
      id: "m1",
      sessionID: "s-root",
      role: "assistant",
      parentID: "um1",
      modelID: "glm-5.3",
      providerID: "ollama-cloud",
      mode: "build",
      agent: "build",
      time: { created: 0, completed: 5000 },
      tokens: { input: 10, output: 120, reasoning: 10, cache: { read: 0, write: 0 } },
      ...over,
    },
  },
})

describe("createStatsCapture — captura wire → handoff", () => {
  test("end-to-end: respuesta SSE real produce una medición wire en el handoff", async () => {
    const dir = await tempDir()
    const capture = createStatsCapture({ handoffDir: dir })
    const original = globalThis.fetch
    const seen: RequestInfo[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(input as RequestInfo)
      return sseResponse(sseBody(120))
    }) as unknown as typeof fetch
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT)
      const response = await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), {
        method: "POST",
      })
      const text = await response.text()
      // bytes passthrough untouched
      expect(text).toContain('{"id":"x"')
      expect(text).toContain("[DONE]")

      // let the stream pump settle, then the assistant message claims the pending
      await new Promise((r) => setTimeout(r, 20))
      await capture.handleEvent(ASSISTANT_UPDATE())

      const collector = capture.collectors.get("s-root")
      expect(collector?.summary().steps).toBe(1)
      expect(collector?.summary().tokensOutTotal).toBe(120)
      expect(collector?.summary().avgTps).toBeGreaterThan(0)

      const file = await capture.store.read()
      expect(isHandoffFile(file)).toBe(true)
      expect(file?.sessionID).toBe("s-root")
      expect(file?.steps[0]?.source).toBe("wire")
      // the wrapper only takes over the chat endpoint; session header present
    } finally {
      globalThis.fetch = original
    }
  })

  test("requests con header de sesión hija (x-parent-session-id) pasan sin medir", async () => {
    const dir = await tempDir()
    const capture = createStatsCapture({ handoffDir: dir })
    const original = globalThis.fetch
    globalThis.fetch = (async () => sseResponse(sseBody(10))) as unknown as typeof fetch
    try {
      const response = await capture.wireFetch(
        wireRequest({ "x-session-id": "sa-child", "x-parent-session-id": "s-root" }),
      )
      expect(response.ok).toBe(true)
      await new Promise((r) => setTimeout(r, 10))
      expect(capture.collectors.size).toBe(0) // subagentes: ni siquiera penden
    } finally {
      globalThis.fetch = original
    }
  })

  test("no-chat URLs y calls sin session header pasan intocados", async () => {
    const dir = await tempDir()
    const capture = createStatsCapture({ handoffDir: dir })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      return new Response(`hit:${url}`, { status: 200 })
    }) as unknown as typeof fetch
    try {
      const r1 = await capture.wireFetch("https://ollama.com/v1/models")
      expect(await r1.text()).toContain("hit:")
      const r2 = await capture.wireFetch(wireRequest()) // sin x-session-id
      expect(await r2.text()).toContain("hit:")
    } finally {
      globalThis.fetch = original
    }
  })

  test("compaction hereda el modelo pero la regla la excluye", async () => {
    const dir = await tempDir()
    const capture = createStatsCapture({ handoffDir: dir })
    const original = globalThis.fetch
    globalThis.fetch = (async () => sseResponse(sseBody(50))) as unknown as typeof fetch
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT)
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), { method: "POST" })
      await new Promise((r) => setTimeout(r, 20))
      await capture.handleEvent(ASSISTANT_UPDATE({ agent: "compaction", mode: "compaction", summary: true }))
      expect(capture.collectors.get("s-root")?.summary().steps).toBe(0)
      // el pending queda consumido y sin promoverlo: compaction no cuenta
    } finally {
      globalThis.fetch = original
    }
  })

  test("titlegen: sin mensaje asistente que reclame, el pend no llega al summary", async () => {
    const dir = await tempDir()
    const capture = createStatsCapture({ handoffDir: dir })
    const original = globalThis.fetch
    globalThis.fetch = (async () => sseResponse(sseBody(3))) as unknown as typeof fetch
    try {
      await capture.handleEvent(ROOT_SESSION_EVENT)
      await capture.wireFetch(wireRequest({ "x-session-id": "s-root" }), { method: "POST" })
      // ningún message.updated llega (titlegen solo escribe el título):
      // el pend existó y caduca solo; el collector queda con 0 steps
      await new Promise((r) => setTimeout(r, 50))
      expect(capture.collectors.get("s-root")?.summary().steps).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("createStatsCapture — ruta por eventos (otros proveedores)", () => {
  test("part.updated + message.completed produce medición event", async () => {
    const dir = await tempDir()
    const capture = createStatsCapture({ handoffDir: dir })
    await capture.handleEvent({ type: "session.created", properties: { info: { id: "s-free", parentID: null } } })
    const messageID = "mf1"
    await capture.handleEvent({ type: "message.part.updated", properties: { sessionID: "s-free", part: { id: "p1", messageID }, time: 100 } })
    await capture.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          id: messageID,
          sessionID: "s-free",
          role: "assistant",
          parentID: "um",
          modelID: "gpt-5-nano",
          providerID: "opencode",
          mode: "build",
          agent: "build",
          time: { created: 90, completed: 2100 },
          tokens: { input: 1, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    })
    const collector = capture.collectors.get("s-free")
    expect(collector?.summary().steps).toBe(1)
    expect(collector?.summary().tokensOutTotal).toBe(50)
    const recent = collector?.recent(1)[0]
    expect(recent?.source).toBe("event")
    expect(recent?.ttftMs).toBe(10) // 100 − 90
    expect(recent?.decodeMs).toBe(2000) // 2100 − 100
  })
})