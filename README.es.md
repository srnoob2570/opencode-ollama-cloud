# @srnoob2570/opencode-ollama-cloud

[![npm](https://img.shields.io/npm/v/@srnoob2570/opencode-ollama-cloud)](https://www.npmjs.com/package/@srnoob2570/opencode-ollama-cloud)
[![Catalog update](https://github.com/srnoob2570/opencode-ollama-cloud/actions/workflows/update.yml/badge.svg)](https://github.com/srnoob2570/opencode-ollama-cloud/actions/workflows/update.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Read in English →](README.md)

Plugin de [opencode](https://opencode.ai) que registra el proveedor **Ollama Cloud** con una lista de modelos siempre actualizada, tomada en vivo de `https://ollama.com/v1/models`.

models.dev (la fuente de modelos de opencode) se actualiza manualmente por PR y se queda desactualizado. Este plugin consume un catálogo estático mantenido por GitHub Actions, así que los modelos nuevos aparecen sin esperar a nadie.

> [!NOTE]
> **Transparencia:** este plugin, su actualizador de catálogo y esta documentación fueron generados y son mantenidos con asistencia de IA ([opencode](https://opencode.ai)). Revisa el código antes de confiar en él para algo sensible.

## Inicio rápido

```bash
opencode plugin @srnoob2570/opencode-ollama-cloud --force --global
```

`--force` reemplaza una versión ya instalada — opencode no tiene comando de actualización de plugins, así que repetir este comando es la forma de actualizar. `--global` instala en `~/.config/opencode/opencode.json` en vez de en la config del proyecto.

Eso es todo. Reinicia opencode y verifica:

```bash
opencode models ollama-cloud --refresh
```

Deberías ver la lista live completa (ej. `ollama-cloud/glm-5.3-flash`), incluyendo modelos que models.dev aún no tiene.

> Asume que ya configuraste tu API key de ollama.com (`opencode auth login` → `ollama-cloud`). Si el proveedor ya estaba registrado, el plugin solo refresca su lista de modelos.

## Cómo funciona

```
ollama.com/v1/models ──┐
                       ├─→ GitHub Action (cada 15 min) ─→ catalog/catalog.json (auto-commit)
ollama.com/library/* ──┘

catalog.json (jsDelivr, purgado tras cada commit / raw.githubusercontent / cache local) ─→ plugin ─→ opencode
```

**Action** (`.github/workflows/update.yml`): corre `bun scripts/update-catalog.ts update` con cron cada 15 minutos. Barato por diseño — el check es 1 GET a `/v1/models`; el scraping solo ocurre si la lista cambió (o una vez por semana, para refrescar los datos de enriquecimiento). El catálogo actualizado se valida (`bun scripts/validate-catalog.ts`) antes de commitear. Peor caso de staleness ≈ 15 min + propagación CDN.

- `check`: compara el hash de `{id, created}` de `/v1/models` contra el catálogo commiteado. Sin scraping.
- `update`: si el hash cambió (o el catálogo tiene más de 7 días), scrapea `ollama.com/library/<base>` (1 request por familia, ~15 requests), enriquece con datos sembrados de models.dev (max output tokens, fechas de release) y escribe `catalog/catalog.json`. Si no cambió, no toca nada. Si un scrape falla y no hay datos previos que conservar, el update aborta en vez de publicar un catálogo degradado.
- `validate`: puerta estructural y de sanidad para `catalog/catalog.json` (la usa CI; corréla localmente tras editar a mano).

**Plugin** (`plugin/index.ts`): hook `config` registra el provider (idempotente) y hook `provider` devuelve los modelos normalizados al schema de opencode, con cascada de fallback:

1. Catálogo remoto (jsDelivr → raw.githubusercontent.com)
2. Cache local en `~/.cache/opencode-ollama-cloud/catalog.json`
3. Passthrough de models.dev (los modelos que opencode ya tiene)

## Instalación manual

¿Prefieres editar la config a mano? Agrega el plugin a `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@srnoob2570/opencode-ollama-cloud"]
}
```

### Local (desde un clon de este repo)

```json
{
  "plugin": ["/ruta/a/opencode-ollama-cloud/plugin/index.ts"]
}
```

### Opciones

```json
{
  "plugin": [
    [
      "@srnoob2570/opencode-ollama-cloud",
      { "catalogUrl": "https://mi-cdn/catalog.json" }
    ]
  ]
}
```

- `catalogUrl`: URL alternativa del catálogo (se intenta primero).
- `timeoutMs`: timeout de cada fetch (default `5000`).
- `pricing`: `"on"` (default) o `"off"` — si el contador de costos de opencode muestra la tarifa oficial de Ollama Cloud. `pricing: "reference"` (el valor viejo opt-in) sigue funcionando y significa `"on"`.

```json
{
  "plugin": [["@srnoob2570/opencode-ollama-cloud", { "pricing": "off" }]]
}
```

El catálogo trae la **tarifa oficial de Ollama Cloud** por modelo — precios de input, cached input y output en USD por 1M de tokens, directamente de la [rate card](https://ollama.com/pricing) pública de Ollama en `catalog/pricing.json`. Es lo que tus créditos pagan de verdad por token, así que el contador de costos de opencode la muestra por defecto (opt-out: `pricing: "off"` la apaga). Los modelos sin tarifa quedan en $0 (sin estimaciones a medias).

Actualizar la tabla es un **workflow manual de GitHub Actions** (`.github/workflows/update-pricing.yml`): disparás `update-pricing` desde la pestaña Actions (o `gh workflow run update-pricing`) y fetcha la rate card viva, imprime un diff tarifa-por-tarifa en el log del run, reescribe `catalog/pricing.json` y commitea el cambio, purgando la caché de jsDelivr para que los usuarios reciban las tarifas nuevas. Si la página y el catálogo no cuadran (un modelo nuevo o retirado), aborta con un reporte y no escribe nada. No hay ningún schedule — las tarifas cambian solo cuando vos disparás el run. El mismo script funciona desde tu máquina (`bun run update-pricing`); el update automático del catálogo jamás toca el pricing de ninguna de las dos formas.

## Estadísticas de streaming y ficha de modelo

El plugin mide lo que opencode no guarda: **TTFT** (tiempo hasta el primer
token) y **tokens/s** de cada LLM step, del lado del cliente — con precisión de
wire en `ollama-cloud` (el plugin envuelve el `fetch` del provider y lee el
chunk final de `usage` que opencode ya pide) y por eventos para cualquier otro
proveedor. Muestra el **promedio de la sesión** — las métricas son de la
sesión, no del modelo activo (sin desglose por modelo ni reset al cambiar), —
junto al contador de tokens:

```
12.4k tokens (23%) · $0.02 · 38.2 tok/s · TTFT 380 ms · Session average
```

- `/stats` — resumen de sesión y últimas respuestas (detalle por step; las
  filas `wire` y `event` son distinguibles).
- `/model` — ficha del modelo activo: cuantización, familia, capacidades,
  límites, release y la tarifa oficial (input · cached input · output por 1M;
  salvo `pricing: "off"`).

El promedio solo cuenta el **chat principal**: subagentes, titlegen y
compaction jamás entran (señales verificadas contra el código de opencode).
Los números viven en memoria por sesión — no se persiste nada ni sale nada de
tu máquina. La UI de stats es una segunda entrada de plugin y degrada en
silencio: en un opencode donde la API TUI cambió, provider/catálogo siguen
funcionando y las stats simplemente desaparecen (probado contra opencode
**1.18.27**; la API que usa existe pero no está documentada — stats UI es
best-effort hasta que upstream la documente).

La entrada del provider vive en el array `plugin` de `opencode.json`, como
siempre. **La entrada de la TUI va en `tui.json`**: desde opencode 1.18, el
host TUI solo carga sus plugins desde `~/.config/opencode/tui.json` (o el del
proyecto) — el array `plugin` de `opencode.json` se ignora en el lado TUI.

opencode.json:

```json
{
  "plugin": [["@srnoob2570/opencode-ollama-cloud", {}]]
}
```

~/.config/opencode/tui.json (una ruta de archivo directa es la forma
verificada; con instalación por npm, apúntala al `tui.tsx` dentro del paquete
instalado):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/ruta/absoluta/a/opencode-ollama-cloud/plugin/tui.tsx"]
}
```

- `stats`: `"on"` (default) o `"off"` — ponlo en **ambas entradas** (forma de
  tupla, p. ej. `["…", { "stats": "off" }]`) y todo se apaga: sin medición,
  sin UI, exactamente el plugin de siempre.

### Cuantización: declarada, no garantizada

La **cuantización** de la ficha es el valor que Ollama **declara** para el
modelo que sirve (`file_type` del registry, contrastado con `/api/show`),
investigado por modelo y transportado en el catálogo — **no** garantiza la
precisión a la que corre realmente la inferencia remota. Los modelos sin
fuente pública defendible muestran `unknown` (nunca se inventan), y los
modelos fuera del catálogo muestran `—`.

Crédito del origen de la idea: el usuario de GitHub
**[@adilfaisal01](https://github.com/adilfaisal01)**.

## Desarrollo

```bash
bun install
bun run check           # ¿cambió la lista de modelos? (sin scraping)
bun run update          # regenera catalog/catalog.json si cambió
bun run update --force  # regenera aunque la lista no cambie (enriquecimiento nuevo)
bun run typecheck
```

## Cambios

Cada versión tiene su entrada en [CHANGELOG.md](CHANGELOG.md) (en inglés) y su [release en GitHub](https://github.com/srnoob2570/opencode-ollama-cloud/releases). Las ramas de release están en `release/v*`.

## Licencia

MIT
