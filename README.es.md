# opencode-ollama-cloud

[Read in English →](README.md)

Plugin de [opencode](https://opencode.ai) que registra el proveedor **Ollama Cloud** con una lista de modelos siempre actualizada, tomada de `https://ollama.com/v1/models`.

models.dev (la fuente de modelos de opencode) se actualiza manualmente por PR y se queda desactualizado. Este plugin consume un catálogo estático mantenido por GitHub Actions: la Action compara la lista live de `/v1/models` contra el catálogo commiteado y solo hace scraping + commit cuando la lista cambia.

## Cómo funciona

```
ollama.com/v1/models ──┐
                       ├─→ GitHub Action (cada 6h) ─→ catalog/catalog.json (auto-commit)
ollama.com/library/* ──┘

catalog.json (jsDelivr / raw.githubusercontent / cache local) ─→ plugin ─→ opencode
```

**Action** (`.github/workflows/update.yml`): corre `bun scripts/update-catalog.ts update`.

- `check`: compara el hash de `{id, created}` de `/v1/models` contra el catálogo commiteado. Sin scraping.
- `update`: si el hash cambió, scrapea `ollama.com/library/<base>` (1 request por familia, ~15 requests), enriquece con datos sembrados de models.dev (max output tokens, fechas de release) y escribe `catalog/catalog.json`. Si no cambió, no toca nada.

**Plugin** (`plugin/index.ts`): hook `config` registra el provider (idempotente) y hook `provider` devuelve los modelos normalizados al schema de opencode, con cascada de fallback:

1. Catálogo remoto (jsDelivr → raw.githubusercontent.com)
2. Cache local en `~/.cache/opencode-ollama-cloud/catalog.json`
3. Passthrough de models.dev (los modelos que opencode ya tiene)

## Instalación

### Desde npm (cuando esté publicado)

```bash
opencode auth login
# selecciona ollama-cloud y pega tu API key de ollama.com

opencode install opencode-ollama-cloud
```

O agrega el plugin a `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ollama-cloud"]
}
```

### Local (desde el repo)

```json
{
  "plugin": ["/ruta/a/opencode-ollama-cloud/plugin/index.ts"]
}
```

### Opciones

```json
{
  "plugin": [["opencode-ollama-cloud", { "catalogUrl": "https://mi-cdn/catalog.json" }]]
}
```

- `catalogUrl`: URL alternativa del catálogo (se intenta primero).
- `timeoutMs`: timeout de cada fetch (default `5000`).

## Uso

Reinicia opencode y verifica:

```bash
opencode models
```

Deberías ver `ollama-cloud/<modelo>` con la lista live (incluye modelos nuevos como `glm-5.3-flash` que models.dev aún no tiene).

## Desarrollo

```bash
bun install
bun run check      # ¿cambió la lista de modelos? (sin scraping)
bun run update     # regenera catalog/catalog.json si cambió
bun run typecheck
```

## Licencia

MIT