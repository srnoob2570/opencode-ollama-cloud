# Brainstorm: features para opencode-ollama-cloud (2026-08-30)

Spike de investigación: quejas de usuarios de OpenCode (anomalyco/opencode) y de Ollama Cloud
(ollama/ollama + Reddit), excluyendo la de catálogo limitado. Cruce contra lo que el plugin ya hace.

## Quejas encontradas (síntesis)

### OpenCode
- Fugas de memoria del TUI (issue más votado; hasta 187 GB RSS) [#20695](https://github.com/anomalyco/opencode/issues/20695)
- Compaction destruye contexto; resúmenes vacíos con modelos reasoning custom [#44080](https://github.com/anomalyco/opencode/issues/44080), [#16512](https://github.com/anomalyco/opencode/issues/16512)
- Sistema de plugins: breaking changes V1→V2 sin deprecación; errores de carga silenciosos [#39345](https://github.com/anomalyco/opencode/issues/39345), [#42878](https://github.com/anomalyco/opencode/issues/42878)
- API de plugins mal documentada; tipos `ProviderContext` no coinciden con runtime [#20562](https://github.com/anomalyco/opencode/issues/20562)
- Specs de models.dev incorrectas (contexto/costos) → compact mal y $ mal estimados [#42910](https://github.com/anomalyco/opencode/issues/42910)
- Modelos custom invisibles en el picker del TUI [#6169](https://github.com/sst/opencode/issues/6169), [#7958](https://github.com/anomalyco/opencode/issues/7958)
- Tool calling poco confiable con Ollama; `num_ctx` default ~4k [#1034](https://github.com/sst/opencode/issues/1034), [#4428](https://github.com/anomalyco/opencode/issues/4428)
- Reasoning mal manejado en OpenAI-compatible: `reasoning_content` ausente en tool-calls replayados (Kimi/DeepSeek errorizan); tags `<think>` inline se filtran [#43770](https://github.com/anomalyco/opencode/issues/43770), [#25758](https://github.com/anomalyco/opencode/issues/25758)
- Zod dual-instance rompe plugins ("not a Zod schema") [guía community](https://youcanbuildthings.com/articles/opencode-not-working-fixes/)
- SSE timeouts / desconexiones [#17318](https://github.com/anomalyco/opencode/issues/17318)

### Ollama Cloud
- "Server overloaded" intermitente en planes pagos con cuota intacta [#15419](https://github.com/ollama/ollama/issues/15419)
- Velocidad inusable en hora pico (colas 30-60 s, stalls); bien off-peak [r/ollama](https://reddit.com/r/ollama/comments/1sy485i/)
- Sin status page ni Retry-After; soporte en weeks de atraso [#17756](https://github.com/ollama/ollama/issues/17756)
- Timeout duro de ~182 s del servidor + streaming sin keepalive mata turnos agénticos [#15973](https://github.com/ollama/ollama/issues/15973), [#16108](https://github.com/ollama/ollama/issues/16108)
- Tool calling roto en :cloud: args de tool_call truncados 502 con ~60-100 líneas [#16066](https://github.com/ollama/ollama/issues/16066)
- Structured outputs ignorados silenciosamente en cloud (confirmado por mantenedor) [#12362](https://github.com/ollama/ollama/issues/12362)
- Paywall silencioso (403 "requires a subscription" de un día para el otro) [#15741](https://github.com/ollama/ollama/issues/15741); cuota recortada sin aviso [#17435](https://github.com/ollama/ollama/issues/17435)
- Retiros de modelos (410) de golpe, sin ventana útil [#15991](https://github.com/ollama/ollama/issues/15991)
- Sin API de uso/cuota (solo el medidor web, fracción opaca por "GPU time") [pi-ollama-cloud#42](https://github.com/fgrehm/pi-ollama-cloud/issues/42)
- Auth contradictoria: la misma cuenta Pro tiene cuota vía `ollama signin` pero 402 vía API key contra `ollama.com/v1` [#17639](https://github.com/ollama/ollama/issues/17639); docs de auth erróneas [#13854](https://github.com/ollama/ollama/issues/13854)

## Lectura puente

El plugin no puede arreglar servidores, colas ni la comunicación de Ollama, pero sí
la experiencia alrededor: resiliencia cliente-side, transparencia del catálogo y
onboarding. Su catálogo propio ya ataca la queja #6 de OpenCode (specs de models.dev)
— la idea es extender ese mismo eje (verdad exacta sobre los modelos) a pricing,
estado de suscripción y retiros.

## Features propuestas (priorizadas)

### Tier 1 — resiliencia y transparencia (bajo riesgo, alto valor)

1. **Defaults de reintentos + detección de overload.** Configurar retry/backoff del
   provider y envolver el `fetch` para reconocer 502/503/"Server overloaded" (que no
   manda `Retry-After`) y loguear un aviso accionable en vez de fallar en silencio.
   Ataca: overload intermitente + timeouts SSE.
2. **Retiros de modelos sin romper sesiones.** El pipeline ya detecta bajas vía hash;
   en vez de soltar el modelo, marcarlo `status: "deprecated"` N días en el catálogo.
   Ataca: 410 de golpe.
3. **Transparencia de suscripción.** Scrapear el indicador de plan pago en las páginas
   de library y exponerlo en el catálogo (nombre/filtrado), para no descubrir el 403
   a mitad de sesión. Ataca: paywall silencioso.
4. **Auth UX.** Al cargar, si no hay `OLLAMA_API_KEY` (ni config), un warning accionable
   (`opencode auth login` → ollama-cloud). README con la tabla signin-vs-API-key
   (cuota incluida vs 402). Ataca: auth contradictoria.

### Tier 2 — specs

5. **Costos reales en vez de `0`.** Mapa manual de precios (los `:cloud` facturan por
   uso bajo API key) con override opcional → opencode muestra $ de sesión reales.
   Ataca: specs incorrectas + costos mal estimados.
6. **`maxOutput` por modelo** en lugar del default 32768 hardcodeado.

### Tier 3 — más ambicioso / a investigar

7. **Compaction safeguard** vía `experimental.session.compacting` para el caso de
   resúmenes vacíos con modelos reasoning. Riesgo: API experimental en un ecosistema
   con breaking changes documentados; medir primero.
8. **Curación del picker:** opts `filter`/`recommended` (p.ej. solo tools+thinking+ctx
   grande) contra el bug de descubribilidad del TUI.
9. **CI de compatibilidad:** smoke test de carga del plugin contra cada release de
   opencode (el loader traga errores y "desaparece" plugins).

### Fuera de alcance (no es culpa del plugin ni arreglable cliente-side)

Velocidad/colas en hora pico; status page y comunicación de incidentes; embeddings y
structured outputs en cloud; truncado de tool args (~60-100 líneas) — solo detectable
para avisar; cuota/uso (no hay API pública; la comunidad scrapea la web con cookies).