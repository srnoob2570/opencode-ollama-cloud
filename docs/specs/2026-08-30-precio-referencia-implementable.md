---
triage: ready-for-agent
fecha: 2026-08-30
fuente: wayfinder "Precio de referencia y fuentes endurecidas" — mapa, tickets cerrados y spec de decisión en wayfinder/ y docs/specs/2026-08-30-precio-referencia-y-fuentes-endurecidas.md
---

# Spec: precio de referencia opt-in y fuentes endurecidas

## Problem Statement

Los usuarios del plugin de Ollama Cloud en opencode ven sesiones a "$0.00": el
catálogo no dice cuánto costaría cada modelo por una API normal (la suscripción
de Ollama no cobra por uso, y su tarifa real solo es visible dentro del panel
del usuario — no existe rate card pública). Al mismo tiempo, las
especificaciones del catálogo (capabilities, contexto, tope de salida) se
obtienen casi enteras de scrapear HTML de ollama.com que puede cambiar sin
aviso, con un tope de salida inventado (32 768) cuando no hay datos, y sin
modo de contrastar varias fuentes: los errores llegan al usuario como
"prompt too long" a mitad de sesión o como features que los modelos no tienen.

## Solution

El catálogo publica un **precio de referencia** por modelo (tarifa de la API
upstream, en USD/1M) que se construye solo: models.dev con una regla
first-party como fuente primaria, litellm como testigo que denuncia
desacuerdos, y un archivo de overrides manual para corregir drifts. El plugin
muestra ese precio en el contador de costos de opencode **solo si el usuario
lo enciende** (default apagado — no es facturación). En paralelo, el
enriquecimiento de specs se vuelve curación multi-fuente con prioridades fijas
por campo: registry de ollama (JSON sin auth) como primaria de capabilities, HTML
como respaldo, OpenRouter y litellm como testigos, con **procedencia y
conflictos registrados dentro del propio catálogo** y avisos en CI (sin
fallas duras por desacuerdo). El tope de salida real por modelo reemplaza al
valor hardcodeado.

## User Stories

1. Como usuario de opencode con modelos ollama-cloud, quiero ver un costo
   aproximado por sesión en el contador de opencode, para entender cuánto
   "valdría" mi uso por una API de pago sin ser facturado.
2. Como usuario, quiero que el costo de referencia venga **apagado** por
   defecto, para que mi contador siga en $0.00 hasta que yo decida verlo.
3. Como usuario que activó la referencia, quiero que los modelos sin precio
   muestren $0, para no ver nunca una estimación a medias o inventada.
4. Como usuario, quiero leer en el README que los precios son de referencia
   y dónde ver la tarifa real, para no confundir estimación con facturación.
5. Como maintainer del catálogo, quiero reglas automáticas first-party
   (glm→zai, kimi→moonshotai, deepseek→deepseek, qwen→alibaba,
   nemotron→nvidia, minimax→minimax, mistral→mistral), para que los precios
   se llenen solos sin mantenimiento manual diario.
6. Como maintainer, quiero que litellm corra como testigo de los precios, para
   que un precio obsoleto de models.dev (como los de DeepSeek durante agosto)
   aparezca como conflicto visible en vez de publicarse en silencio.
7. Como maintainer, quiero un archivo de overrides claveado por id que gane
   sobre todos los feeds, para corregir casos persistentes en un solo lugar
   auditable vía diff del commit.
8. Como maintainer, quiero 7 overrides ya ratificados (DeepSeek ×2 a tarifa
   oficial vigente, 4 modelos sin upstream, glm-5.3-flash a precio de lista),
   para que el catálogo nazca correcto sin esperar mi intervención.
9. Como maintainer, quiero que `capabilities` salga del registry de ollama
   (JSON estructurado, sin auth ni daemon), para dejar de depender de que el
   markup de ollama.com no cambie.
10. Como maintainer, quiero conservar el scrape HTML como respaldo, para que
    los 4 modelos invisibles al registry (mistral-large-3, gpt-oss ×2,
    nemotron nano) no pierdan specs.
11. Como maintainer, quiero un campo de procedencia por modelo (qué fuente
    proveyó cada valor), para auditar de dónde salió cada dato sin reconstruir
    la historia.
12. Como maintainer, quiero los conflictos entre fuentes grabados en el
    catálogo con el resolver aplicado, para que un desacuerdo sea un dato
    visible, no un bug misterioso.
13. Como usuario de opencode, quiero que `context` siga significando la
    ventana servida por ollama, para que el auto-compact no me corte la sesión
    con "prompt too long" cuando las fuentes discrepan.
14. Como maintainer, quiero per-modelo `maxOutput` real (models.dev →
    OpenRouter como respaldo), para jubilar el default hardcodeado de 32 768
    que corta o sobrepromete generaciones.
15. Como maintainer, quiero que litellm actúe de tope upstream (servido >
    upstream = alerta), para detectar valores imposibles sin sonda a la API.
16. Como maintainer, quiero que el updater use OpenRouter/litellm solo en
    runs de update (mismo gate de hash que el seed), para que `check` siga
    siendo un GET mínimo y la cortesía hacia ollama.com no se degrade.
17. Como maintainer, quiero que el CI avise los desacuerdos pero nunca falle
    por ellos, para que un desacuerdo persistente no bloquee la frescura del
    catálogo.
18. Como maintainer, quiero conservar la política de abort-on-regression
    intacta, para que ni esta mejora ni una fuente malhumorada puedan publicar
    un catálogo peor.
19. Como usuario con catálogo cacheado de antes del cambio, quiero que los
    campos nuevos sean opcionales y compatibles, para que el plugin siga
    funcionando antes, durante y después de la transición.
20. Como maintainer, quiero un resumen de conflictos en el mensaje del commit
    del updater, para revisar desacuerdos sin abrir el catálogo grande.
21. Como implementador-agente, quiero toda la curación detrás de una función
    pura testeable con fixtures reales, para desarrollar y regresar sin tocar
    red.
22. Como usuario curioso, quiero saber de qué fuente salió cada precio
    (proveedor y URL), para confiar — o desconfiar — de cada número.

## Implementation Decisions

- **Módulos tocados**: el actualizador del catálogo (parser del registry y
  normalizadores de OpenRouter/litellm, resolución de la curación, fusión de
  overrides, escritura de procedencia/conflictos), el schema del catálogo
  (tres bloques opcionales nuevos), la puerta de validación (validar forma
  nueva sin endurecer política), y el mapeador del plugin (knob de pricing).
  La capa de fetch de cada feed queda como shell fina — como hoy.
- **Contrato de pricing del catálogo** (por modelo, campos opcionales):
  `pricing { input, output, unit: "per-1M", provider, source, asOf, note? }`,
  `sources { campo → registry | html | models.dev | openrouter | litellm |
  override }` y `conflicts { campo → { valores por fuente, resolver } }`.
  La unidad "per-1M" es constante del catálogo.
- **Prioridad de pricing**: overrides > regla first-party internacional sobre
  el seed de models.dev (fallback: moda del marketplace marcada
  `provider: "derived"`). **litellm jamás escribe valores**: solo testigo que
  registra conflicto. **OpenRouter jamás aporta precios** (su base es el
  endpoint descontado del marketplace; 10/19 más barato que el first-party).
- **Overrides**: archivo JSON del catálogo, clave por id, gana sobre todo, con
  input/output/provider/source/note; nace con **7 entradas ratificadas** —
  deepseek-v4-pro:0813 1.32/3.96, deepseek-v4-flash:0731 0.44/1.32 (tarifas
  oficiales peak vigentes), gemma4:31b 0.14/0.4, gpt-oss:120b 0.15/0.6,
  gpt-oss:20b 0.05/0.2, nemotron-3-nano:30b 0.05/0.2 (todas con doble testigo
  + canal vendor) y glm-5.3-flash 0.15/0.5 (pin de LISTA contra la promo −50%
  del seed, vigente hasta 2026-09-09).
- **Knob del plugin**: opción `pricing: "off" | "reference"`, **default
  "off"**. En `"reference"`: modelo con `pricing` → costo del modelo =
  referencia (`cache` en 0); modelo sin `pricing` (catálogo viejo o
  passthrough models.dev) → costo 0, sin estimación parcial.
- **Registry**: manifests `cloud` del base + config blob (ruta namespaced);
  per-tag = build local, jamás sirve de spec de serving; la variante servida
  se deduce de `remote_model` (cubre gemma4:31b, deepseek-v4-*, qwen3.5:397b).
  Cobertura 15/19; `capabilities` llega como lista — claves desconocidas se
  ignoran.
- **Tabla campo→fuente** (primaria / respaldo / testigo): capabilities →
  registry / HTML / OR+litellm; context → HTML servido / registry como
  referencia / OR ref; maxOutput → models.dev / OpenRouter /
  litellm-tope; input → HTML / registry / OR+litellm; reasoningOptions y
  releaseDate → models.dev / OR.
- **Conflictos inaugurales esperados**: glm-5.2 (999 424 servido vs 1 048 576
  arquitectural), minimax-m2.7 (204 800 vs 196 608) — datos, no bugs.
- **CI**: desacuerdo entre fuentes = aviso (nunca falla); abort-on-regression
  se mantiene para catálogos degradados (contexto < 1, campos faltantes).
- **Disclosure README** (EN/ES): los precios son de referencia, no facturación;
  tu plan no cobra por uso; la tarifa real solo en tu panel de ollama.com.

## Testing Decisions

- Un buen test **prueba comportamiento observable de funciones puras con
  fixtures inline** — nunca detalles de implementación, nunca red. La curación
  queda completa detrás de una sola función pura del updater
  (live + registry + HTML + seed + OpenRouter + litellm + overrides →
  modelos + conflicts + warnings), testeable con fragmentos reales de los
  cuatro inventarios de research. Es el seam —uno solo— y coincide con la
  artesanía existente (funciones exportadas, fixtures que copian markup/datos
  reales, `bun test` colocado); la capa de fetch sigue siendo shell sin test.
- **Casos de test**: normalizadores nuevos (registry blob con lista de caps y
  claves desconocidas — mismo patrón que el fixture DRIFTED_MARKUP existente;
  normalizadores de OpenRouter/litellm con sus gotchas: sufijos y claves vendor);
  resolver con prioridad y registro de `sources`/`conflicts` (override gana,
  witness solo marca, served-wins en contexto); fusión de overrides; compat de
  `isCatalog` con/without campos nuevos; mapeador del plugin con knob en ambos
  estados y con catálogo antiguo sin campos nuevos.
- **Prior art**: los dos archivos de test existentes (fixtures espejo de
  entradas reales del catálogo; fixtures de markup de library con detección de
  drift), y su estilo bun/describe/test.

## Out of Scope

- Reintentos y detección de sobrecarga del servicio; marcado de retiros
  (deprecated); UX de autenticación; curación/filtrado del picker; safeguard
  de compaction; tiers cache/image del pricing; **nivel GPU y flag
  "extra usage only"**; cambios de publicación npm / purge jsDelivr; cualquier
  re-arquitectura configurable de fuentes (el ranking es fijo).

## Further Notes

- Sin rate card pública de Ollama: la tarifa por token solo existe en el panel
  del usuario — por eso el precio publicado es "de referencia" y la palabra
  importa en el README.
- Mantenimiento esperado en operación: solo cuando el resumen del commit del
  updater denuncie un desacuerdo seed-vs-litellm (hoy no queda ninguno más
  allá de los overrides fundacionales).
- Fuente de verdad de las decisiones: el mapa wayfinder y su spec de decisión
  (link en el frontmatter); este documento es la síntesis lista para agente.
- Regla del repo: no commitear sin pedido explícito del owner.