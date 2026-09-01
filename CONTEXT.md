# Context — opencode-ollama-cloud

## Términos

- **Familia / `family`**: la base de un id de modelo (`familia[:tag]`), sin la parte del tag. `family` es el vocabulario canónico (campo de `CatalogModel`); el alias "base" quedó descartado el 2026-08-31 y el código legacy que lo usa converge a `family` (SIMPL-011).
- **LLM step**: cada completion streaming individual dentro de un turno del asistente (tool calls, reintentos y compaction incluidos). Unidad de medición del streaming: TTFT/TPS se miden por step, no por vuelta del asistente.
- **TTFT (time to first token)**: latencia hasta el primer token de un LLM step — tiempo desde el envío del request hasta el primer token.
- **TPS (de decodificación)**: tokens de salida del step (reasoning incluido) por segundo de decodificación — entre el primer token y el fin del stream; no penaliza el TTFT.
- **Promedio de sesión**: métrica agregada en vivo del chat principal, sin desglose por modelo ni reset al cambiar de modelo: TPS ponderado por tokens (tokens totales de salida ÷ tiempo total de decodificación) y TTFT como media simple por step. No persiste entre sesiones.
- **Ficha de modelo**: vista del detalle de un modelo (cuantización, familia, capacidades, límites, release, precio de referencia) servida por el catálogo para los modelos ollama-cloud; para modelos fuera del catálogo muestra solo lo que opencode conoce, sin estimar datos. Vive en el comando `/model`.
- **Cuantización**: metadato declarativo que Ollama expone del modelo servido (`file_type` del registry, `quantization_level` de `/api/show`). No es garantía del build ni de la precisión efectiva de la inferencia remota. Sin fuente defendible → el valor canónico es `unknown`, nunca se inventa.
