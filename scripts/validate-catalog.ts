import { PROVIDER_ID, isCatalog } from "../plugin/catalog.ts"

// CI gate run after `update` and before any commit: refuse to publish a catalog
// that fails the structural contract (isCatalog mirrors catalog.schema.json,
// including context >= 1) or sanity checks. Without this, a scrape regression
// (e.g. ollama.com markup drift) would be auto-committed and pushed to the CDN.
const CATALOG_PATH = new URL("../catalog/catalog.json", import.meta.url).pathname

const data: unknown = await Bun.file(CATALOG_PATH).json()

const problems: string[] = []
let modelCount = 0
if (!isCatalog(data)) {
  problems.push(
    "fails the structural contract in plugin/catalog.ts (isCatalog) — check for context < 1, missing releaseDate/family, or wrong types",
  )
} else {
  modelCount = data.models.length
  if (data.provider.id !== PROVIDER_ID) {
    problems.push(`provider.id is "${data.provider.id}", expected "${PROVIDER_ID}"`)
  }
  if (data.models.length === 0) problems.push("contains 0 models")
  if (Number.isNaN(Date.parse(data.generatedAt))) problems.push("generatedAt is not a valid datetime")
  if (!/^[0-9a-f]{64}$/.test(data.modelsHash)) problems.push("modelsHash is not a sha256 hex string")
}

if (problems.length > 0) {
  console.error("catalog/catalog.json is invalid:")
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}

console.log(`catalog/catalog.json valid: ${modelCount} models`)
