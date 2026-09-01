import type { Catalog, CatalogModel } from "../plugin/catalog.ts";
import { familyOf } from "./resolve-catalog.ts";

// Shared test fixtures (SIMPL-013). One factory per side of the catalog
// contract — a new required CatalogModel field now means one edit, not four.
// Lives in scripts/ on purpose: packages publish `files: ["plugin", "catalog"]`,
// so fixtures under plugin/ would ship to npm.

/** Minimal valid model; override per test. */
export const catalogModel = (
  id: string,
  overrides: Partial<CatalogModel> = {},
): CatalogModel => ({
  id,
  name: id,
  created: 0,
  family: familyOf(id),
  capabilities: { tools: true, thinking: false, vision: false },
  input: ["text"],
  context: 128 * 1024,
  maxOutput: 32768,
  reasoningOptions: [],
  releaseDate: "2026-08-30",
  ...overrides,
});

export const CATALOG_PROVIDER: Catalog["provider"] = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  api: "https://ollama.com/v1",
  npm: "@ai-sdk/openai-compatible",
  env: ["OLLAMA_API_KEY"],
};

/** Catalog wrapper taking unknown models so invalid-shape fixtures stay untyped. */
export const catalogWith = (
  models: unknown[],
  modelsHash = "0".repeat(64),
) => ({
  provider: CATALOG_PROVIDER,
  generatedAt: "2026-08-30T00:00:00.000Z",
  modelsHash,
  models,
});
