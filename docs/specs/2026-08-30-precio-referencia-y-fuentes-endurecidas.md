# Spec: precio de referencia y fuentes endurecidas para `opencode-ollama-cloud`

**Fecha:** 2026-08-30 · **Estado:** borrador — pendiente de revisión del owner (cierre del mapa)
**Esfuerzo:** wayfinder ["Precio de referencia y fuentes endurecidas"](../../wayfinder/precio-referencia-y-fuentes-endurecidas.map.md) · **Alcance:** decisiones, no implementación.

## 1. Objetivo

Dos piezas, ambas decididas en el mapa y rastreables a su ticket (§7):

1. **Precio de referencia** opt-in: cuánto costaría cada modelo por una API
   normal (la suscripción de Ollama no cobra por uso). El dato vive siempre en
   el catálogo; opencode solo lo muestra si el usuario lo enciende.
2. **Fuentes endurecidas**: el enriquecimiento del catálogo deja de depender
   del scrape HTML como única fuente — registry de ollama estructurado como
   primaria de capabilities, OpenRouter y litellm como testigos, conflictos
   visibles dentro del catálogo.

## 2. Precio de referencia

### 2.1 Semántica

"Precio de referencia" = tarifa `in/out` en **USD por 1M de tokens** del
proveedor upstream del modelo. **No es facturación**: los usuarios con plan
no pagan por uso; la tarifa real de Ollama solo existe dentro del panel del
usuario (no hay rate card pública — research
[rate card](../../research/rate-card-ollama-cloud.md)).

### 2.2 Prioridad de fuentes

1. **Overrides** (`catalog/pricing-overrides.json`, clave por id del catálogo,
   consumido por el updater, gana sobre todo; cambios visibles en el diff del
   commit del catálogo).
2. **Seed models.dev** con la regla first-party internacional (glm→`zai`,
   kimi→`moonshotai`, deepseek→`deepseek`, qwen→`alibaba`, nemotron→`nvidia`,
   minimax→`minimax`, mistral→`mistral`; sin first-party con precio real →
   moda del marketplace, marcada `provider: "derived"`). El seed manda;
3. **litellm es testigo, nunca fuente de valores**: se compara el precio
   calculado con la entrada vendor de litellm; todo desacuerdo se registra
   como conflicto y avisa en el resumen del commit (no falla). OpenRouter
   **nunca** aporta precios (su base es el endpoint descontado del
   marketplace).

Mantenimiento esperado: solo cuando un desacuerdo seed-vs-litellm aparece en
el resumen del CI.

### 2.3 Overrides fundacionales (ratificados)

`catalog/pricing-overrides.json` nace con estas entradas:

| id | input / output ($/1M) | proveniencia |
|---|---|---|
| `deepseek-v4-pro:0813` | 1.32 / 3.96 | tarifa oficial peak vigente (api-docs.deepseek.com) |
| `deepseek-v4-flash:0731` | 0.44 / 1.32 | ídem |
| `gemma4:31b` | 0.14 / 0.4 | Bedrock Mantle de Google (exacto) + novita |
| `gpt-oss:120b` | 0.15 / 0.6 | 4/9 hosts coincidentes |
| `gpt-oss:20b` | 0.05 / 0.2 | together exacto (groq/vertex 0.075/0.3) |
| `nemotron-3-nano:30b` | 0.05 / 0.2 | dos hosts + Bedrock publicado 0.06/0.24 |
| `glm-5.3-flash` | 0.15 / 0.5 | **pin de lista**: la promo −50% del seed (vigente hasta 2026-09-09) no es la referencia |

Formato por entrada:

```jsonc
{
  "<id>": {
    "input": 1.32,
    "output": 3.96,
    "provider": "deepseek",          // o "derived"
    "source": "https://…",           // página/tarifa de donde salió el número
    "note": "peak oficial vigente"   // opcional
  }
}
```

### 2.4 Schema en `catalog.json`

Por modelo (además de los campos actuales):

```jsonc
{
  "id": "glm-5.3-flash",
  "…": "…campos actuales…",
  "pricing": {
    "input": 0.15,          // USD / 1M tokens
    "output": 0.5,          // USD / 1M tokens
    "unit": "per-1M",       // constante del catálogo
    "provider": "zai",      // o "derived"
    "source": "https://…",  // URL de la tarifa
    "asOf": "2026-08-30"    // fecha de la toma
  },
  "sources": { "pricing": "override", "context": "html", "capabilities": "registry", "maxOutput": "models.dev" },
  "conflicts": { "context": { "registry": 1048576, "resolver": "served-wins" } }
}
```

- `catalog.schema.json` valida los tres bloques como **opcionales**;
  `isCatalog()` (plugin) los acepta si están y pasa si no — catálogos viejos y
  el passthrough models.dev nunca se rompen.
- Tiers cache/image del pricing: futuro, fuera de este diseño.

### 2.5 Knob del plugin

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [["@srnoob2570/opencode-ollama-cloud", { "pricing": "reference" }]]
}
```

- `pricing: "off" | "reference"`, **default `"off"`**.
- `"reference"`: modelo con `pricing` → `ModelV2.cost.input/output` = la
  referencia (el contador de $ de opencode pasa de $0.00 al estimado);
  `cost.cache` queda en 0.
- Modelo **sin** `pricing` (catálogo viejo, passthrough models.dev): `cost` 0 —
  sin estimación parcial.
- El plugin no modifica el catálogo; solo el mapeo a `ModelV2`.

### 2.6 Disclosure de README (ES/EN)

> Los precios incluidos son de **referencia** (tarifa de la API upstream), no
> facturación: tu plan Pro/Max no cobra por uso. La tarifa real de cada modelo
> solo es visible en tu panel de ollama.com.

## 3. Fuentes endurecidas (specs)

### 3.1 Cadencia

Registry, OpenRouter y litellm se descargan **solo en runs de update** (hash
cambió o re-scrape semanal). `check` sigue siendo un GET a `/v1/models` (144
GET/día) — cero requests nuevos. Coste por update real: registry ~15
manifests + blobs (~52 requests máx), OpenRouter 1 GET (0.6 MB, sin ETag),
litellm 1 GET (~2 MB), models.dev como siempre.

### 3.2 Registry

- Ruta: `/v2/library/<base>/manifests/cloud` con base = id antes de `:`;
  config en `/v2/library/<base>/blobs/<config.digest>` (ruta namespaced).
  Los manifests **por tag son builds locales** — nunca usarlos para specs de
  serving; la variante servida viene en `remote_model` del config
  (`gemma4:31b`, `deepseek-v4-pro:0813`, `qwen3.5:397b`).
- Cubre 15/19; `mistral-large-3:675b`, `gpt-oss:20b/:120b` y
  `nemotron-3-nano:30b` solo tienen build local → HTML/seed siguen
  cubriendolos.
- `capabilities` llega como lista (incluye `"completion"`): el parser debe
  ignorar claves desconocidas.

### 3.3 Tabla campo→fuente (ratificada)

| campo | primaria | respaldo | testigo |
|---|---|---|---|
| capabilities | registry (cloud) | HTML library | OR binarios + litellm `supports_*` |
| context | HTML (servido) | registry (referencia arquitectural) | OR top_provider (ref, no autoridad) |
| maxOutput | models.dev (`ollama-cloud`) | OpenRouter `top_provider.max_completion_tokens` | litellm: servido > tope upstream = conflicto |
| input | HTML (chips) | registry (`vision`) | OR modalities + litellm vision |
| reasoningOptions | models.dev | OR efforts | — |
| releaseDate | models.dev | — | — |

- `maxOutput` **jubila el fallback 32768**: primaria models.dev (ya trae
  `limit.output` para los 22), respaldo OpenRouter, 32768 solo como último
  recurso cuando ambos falten.
- `context` sigue significando la **ventana servida** (lo que consume el
  auto-compact de opencode); el valor arquitectural del registry se guarda en
  `conflicts` como referencia. Sobrestimar cuesta un 400 "prompt too long";
  subestimar, un compact temprano. Conflictos inaugurales: `glm-5.2`
  (999 424 vs 1 048 576), `minimax-m2.7` (204 800 vs 196 608).

### 3.4 Procedencia y conflictos

- El updater escribe por modelo `sources` (campo→fuente que proveyó el valor:
  `registry | html | models.dev | openrouter | litellm | override`) y
  `conflicts` (valores discrepantes + `resolver` aplicado).
- `validate-catalog.ts` valida la estructura; **no falla** por desacuerdos
  (nominal-vs-servido es persistente). La falla dura sigue siendo solo
  schema/regresión (abort-on-regression intacto). Los conflictos se resumen
  en el mensaje del commit del updater.

## 4. Flujo del updater (resultado final)

`/v1/models` (hash gate) → registry `manifests/cloud` + blobs → HTML
`library/*` para huecos (mismas guardas de no-regresión) → seed models.dev →
regla first-party + overrides de pricing → litellm testigo → `sources` +
`conflicts` → validate → commit.

## 5. Testing

- `update-catalog`: parser de manifest/blob (lista de caps con claves
  desconocidas), mapeo `remote_model`, fusión de overrides, registro de
  conflictos, witness flag seed-vs-litellm.
- `validate-catalog`: campos opcionales nuevos (acepta y valida forma).
- plugin: compatibilidad con catálogo sin `sources`/`pricing`/`conflicts`;
  knob en ambos estados (cost = referencia / cost = 0); passthrough intacto.

## 6. Fuera de alcance (recap)

Reintentos/sobrecarga, retiros/deprecated, paywall-transparency, **nivel GPU
y "extra usage only"**, UX de auth, curación del picker, safeguard de
compaction, tiers cache/image del pricing, implementación (otro esfuerzo).

## 7. Rastreabilidad

| Decisión | Ticket |
|---|---|
| Regla first-party + tabla de 19 + overrides necesarios | [Tabla de precio de referencia por modelo](../../wayfinder/tickets/tabla-precio-por-modelo.md) |
| Cobertura y límites del registry | [Alcance del registry de ollama](../../wayfinder/tickets/alcance-del-registry.md) |
| OpenRouter = validator (maxOutput, caps, anclas; no pricing) | [Inventario OpenRouter](../../wayfinder/tickets/inventario-openrouter.md) |
| litellm = segundo testigo (no seed); `source`/`deprecation_date`; DeepSeek y promo corregidos | [Inventario litellm](../../wayfinder/tickets/inventario-litellm.md) |
| Tabla campo→fuente, `sources`/`conflicts`, CI avisa | [Política de fuentes y conflictos](../../wayfinder/tickets/politica-de-conflictos.md) |
| Prioridad pricing, overrides fundacionales, pricing schema, knob | [Contrato de pricing y knob](../../wayfinder/tickets/contrato-de-pricing-y-knob.md) |