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
opencode plugin @srnoob2570/opencode-ollama-cloud
```

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

**Action** (`.github/workflows/update.yml`): corre `bun scripts/update-catalog.ts update` con cron cada 15 minutos. Barato por diseño — el check es 1 GET a `/v1/models`; el scraping solo ocurre si la lista cambió. Peor caso de staleness ≈ 15 min + propagación CDN.

- `check`: compara el hash de `{id, created}` de `/v1/models` contra el catálogo commiteado. Sin scraping.
- `update`: si el hash cambió, scrapea `ollama.com/library/<base>` (1 request por familia, ~15 requests), enriquece con datos sembrados de models.dev (max output tokens, fechas de release) y escribe `catalog/catalog.json`. Si no cambió, no toca nada.

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
  "plugin": [["@srnoob2570/opencode-ollama-cloud", { "catalogUrl": "https://mi-cdn/catalog.json" }]]
}
```

- `catalogUrl`: URL alternativa del catálogo (se intenta primero).
- `timeoutMs`: timeout de cada fetch (default `5000`).

## Desarrollo

```bash
bun install
bun run check      # ¿cambió la lista de modelos? (sin scraping)
bun run update     # regenera catalog/catalog.json si cambió
bun run typecheck
```

## Licencia

MIT