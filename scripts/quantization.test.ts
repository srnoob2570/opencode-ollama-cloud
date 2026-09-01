import { describe, expect, test } from "bun:test"
import {
  cloudRefFor,
  fileTypeFromBlob,
  quantizationFromShow,
  resolveQuantization,
  IMPLICIT_QUANTIZATION,
  QUANT_UNKNOWN,
} from "./quantization.ts"

describe("cloudRefFor (convención <ref>-cloud, verificada 19/19)", () => {
  test("tagged ids use <tag>-cloud; tagless use cloud", () => {
    expect(cloudRefFor("gpt-oss:120b")).toBe("120b-cloud")
    expect(cloudRefFor("gpt-oss:20b")).toBe("20b-cloud")
    expect(cloudRefFor("nemotron-3-nano:30b")).toBe("30b-cloud")
    expect(cloudRefFor("mistral-large-3:675b")).toBe("675b-cloud")
    expect(cloudRefFor("deepseek-v4-pro:0813")).toBe("0813-cloud")
    expect(cloudRefFor("glm-5.3")).toBe("cloud")
    expect(cloudRefFor("kimi-k3")).toBe("cloud")
  })
})

describe("extracción cruda de los dos canales", () => {
  test("blob file_type string → valor crudo; vacío → null", () => {
    expect(fileTypeFromBlob({ file_type: "FP8" })).toBe("FP8")
    expect(fileTypeFromBlob({ file_type: "" })).toBeNull()
    expect(fileTypeFromBlob({})).toBeNull()
    expect(fileTypeFromBlob(null)).toBeNull()
  })

  test("/api/show details.quantization_level", () => {
    expect(quantizationFromShow({ details: { quantization_level: "FP8" } })).toBe("FP8")
    expect(quantizationFromShow({ details: {} })).toBeNull()
    expect(quantizationFromShow({})).toBeNull()
  })
})

describe("resolveQuantization (registry primario + testigo avisable)", () => {
  test("registry manda cuando tiene valor", () => {
    expect(resolveQuantization({ id: "glm-5.3", registry: "FP8", show: "FP8" })).toEqual({
      quantization: "FP8",
      source: "registry-ollama",
    })
  })

  test("desacuerdo testigo → conflicto visible pero registry gana (CI avisa, no falla)", () => {
    const r = resolveQuantization({ id: "x", registry: "FP8", show: "INT4" })
    expect(r.quantization).toBe("FP8")
    expect(r.conflict).toEqual({ registry: "FP8", "api/show": "INT4", resolver: "registry-wins" })
  })

  test("implícitas investigadas entran con provenance marcada", () => {
    for (const [id, expected] of Object.entries(IMPLICIT_QUANTIZATION)) {
      const r = resolveQuantization({ id, registry: "" })
      expect(r.quantization).toBe(expected.value)
      expect(r.source).toBe(expected.source)
    }
  })

  test("sin fuente defendible → literal unknown (minimax-m3 / minimax-m2.7)", () => {
    expect(resolveQuantization({ id: "minimax-m3" })).toEqual({
      quantization: "unknown",
      source: "sin fuente defendible",
    })
    expect(resolveQuantization({ id: "minimax-m2.7", registry: "", show: "" })).toEqual({
      quantization: "unknown",
      source: "sin fuente defendible",
    })
  })

  test("caída transitoria del registry conserva el valor anterior (sin regresión)", () => {
    expect(resolveQuantization({ id: "kimi-k3", registryFailed: true, previous: "MXFP4" })).toEqual({
      quantization: "MXFP4",
      source: "registry-ollama (corrida anterior)",
    })
    // pero un previous "unknown" no se perpetúa como fuente
    expect(resolveQuantization({ id: "minimax-m2.7", registryFailed: true, previous: "unknown" })).toEqual({
      quantization: "unknown",
      source: "sin fuente defendible",
    })
  })

  test("registry alcanzable pero blob vacío con valor previo: conserva previous + aviso (sin regresión)", () => {
    const r = resolveQuantization({ id: "kimi-k3", registry: "", previous: "MXFP4" })
    expect(r.quantization).toBe("MXFP4")
    expect(r.source).toBe("registry-ollama (corrida anterior — blob vacío ahora)")
    expect(r.warning).toBe("kimi-k3") // CI avisa: posible cambio del registry
    // pero un previous "unknown" sigue resolviendo a unknown (nada que conservar)
    expect(resolveQuantization({ id: "minimax-m2.7", registry: "", previous: "unknown" })).toEqual({
      quantization: "unknown",
      source: "sin fuente defendible",
    })
  })
})