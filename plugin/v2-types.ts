// Structural types for the opencode 2.x (V2) plugin API surface this package
// consumes. Deliberately local, like `TuiLike` in ./tui.tsx: V2 is beta and the
// host provides these modules at runtime, so importing the published
// `@opencode/plugin` types would pin a V1-compatible package to a moving
// target (and V1 installs do not carry that dependency). Only the shapes this
// plugin touches are declared; the loader ignores unknown fields.

/** Registration handle returned by transforms and hooks. */
export interface V2Registration {
  dispose(): Promise<void>;
}

/** Reasoning/settings variant (Model.Info.variants[]). */
export interface V2Variant {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Cost tier (Model.Info.cost[]; USD per 1M tokens). */
export interface V2Cost {
  tier?: { type: "context"; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
}

export interface V2Capabilities {
  tools: boolean;
  input: string[];
  output: string[];
  responsesWebsockets?: boolean;
}

/** Catalog model (the subset the plugin writes). */
export interface V2ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  family?: string;
  capabilities: V2Capabilities;
  variants: V2Variant[];
  time: { released: number };
  cost: V2Cost[];
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
  limit: { context: number; input?: number; output: number };
  compatibility?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface V2ProviderInfo {
  id: string;
  name: string;
  package: string;
  activation: "auto" | "enabled" | "disabled";
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface V2CatalogProviderRecord {
  provider: V2ProviderInfo;
  models: ReadonlyMap<string, V2ModelInfo>;
}

/** Synchronous editor a catalog transform mutates. */
export interface V2CatalogEditor {
  provider: {
    list(): readonly V2CatalogProviderRecord[];
    get(providerID: string): V2CatalogProviderRecord | undefined;
    update(
      providerID: string,
      update: (provider: V2ProviderInfo) => void,
    ): void;
    remove(providerID: string): void;
  };
  model: {
    get(providerID: string, modelID: string): V2ModelInfo | undefined;
    update(
      providerID: string,
      modelID: string,
      update: (model: V2ModelInfo) => void,
    ): void;
    remove(providerID: string, modelID: string): void;
  };
}

/** Model reference carried by session request hooks and step events. */
export interface V2ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export type V2RequestKind = "primary" | "compaction" | "title" | "generate";

/**
 * Server event as yielded by `ctx.event.subscribe` (OpenCodeEvent). The
 * payload lives under `data` (the legacy `properties` name is accepted too);
 * durable events also carry the location that emitted them.
 */
export interface V2Event {
  type?: string;
  created?: number;
  location?: { directory?: string };
  data?: unknown;
  properties?: unknown;
}

export interface V2SessionInfo {
  id?: string;
  parentID?: string | null;
  agent?: string | null;
}

/** Server plugin setup context (only what this plugin uses). */
export interface V2ServerContext {
  options?: Readonly<Record<string, unknown>>;
  /** Location this plugin instance is loaded for (ctx.location.directory). */
  location?: { directory?: string };
  catalog: {
    transform(
      callback: (editor: V2CatalogEditor) => void,
    ): Promise<V2Registration>;
    reload(): Promise<void>;
  };
  session: {
    get(input: { sessionID: string }): Promise<V2SessionInfo | undefined>;
  };
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>;
  };
}
