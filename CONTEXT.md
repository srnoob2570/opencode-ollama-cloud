# Context — opencode-ollama-cloud

## Términos

- **Catálogo**: el artifact `catalog.json` publicado por `srnoob2570/ollama-cloud-catalog` — forma de models.dev más la extensión `x_ollama`. El plugin lo consume tal cual: no lo construye, y su gate de runtime es `isCatalog` (envelope) + `usableModels` (entrada por entrada).
- **Coste oficial**: la tarifa de Ollama Cloud (USD por 1M de tokens, off-peak) que viaja en el bloque `cost` de cada entrada del catálogo. Es el precio por defecto del contador de opencode; `pricing: "off"` lo apaga. Sin bloque completo, el modelo queda rateless ($0), nunca con un precio inventado.
