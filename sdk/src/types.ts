// Shared wire types for the tfl5 REST contract.
//
// The server always answers a successful call with the envelope
// `{ result: true, data: <payload>, timestamp: <ms> }` and an error with
// `{ code: <machine-code>, msg: <human> }` (see docs/error.rs wire table).
// The SDK unwraps `data` for callers and throws a typed error keyed on
// `code` for everything else.

/** Success envelope returned by every handler. */
export interface SuccessEnvelope<T = unknown> {
  result: true;
  data: T;
  timestamp?: number;
}

/** Error envelope. `code` is the stable machine key; `msg` is localized. */
export interface ErrorEnvelope {
  code?: string;
  msg?: string;
  /** Legacy 401 marker (GAP-8); kept for back-compat detection. */
  isSignout?: boolean;
  result?: boolean;
}

/** Field sensitivity level — mirrors `FieldLevel` server-side. */
export enum FieldLevel {
  /** Indexable plaintext (default) → `data_indexed`. */
  Public = 0,
  /** Encrypted PII → `data_secret`. */
  Sensitive = 1,
  /** Encrypted top-secret PII → `data_secret`. */
  TopSecret = 2,
}

/** One entry of a resource's `fields` schema (array form). */
export interface FieldDecl {
  field: string;
  name?: string;
  /** Validator DSL token, e.g. "required", "email", "int|min:0". */
  validator?: string;
  /** Field-level encryption tier. Absent = level 0 (plaintext/indexed). */
  level?: FieldLevel;
  /** Free-form type hint ("string", "int", "date", "link", ...). */
  type?: string;
}

/** Declarative resource hook (see docs/SDK-GAPS GAP-3 canonical schema). */
export interface Hook {
  id: string;
  on: HookEvent[];
  type: "require_fields" | "set_fields" | "webhook";
  params?: Record<string, unknown>;
  when?: Record<string, unknown>;
  msg?: string;
}

export type HookEvent =
  | "before_create"
  | "after_create"
  | "before_update"
  | "after_update"
  | "before_delete"
  | "after_delete";

/** A stored doc as returned by `/app/doc/get` (secret fields decrypted). */
export interface Doc<T = Record<string, unknown>> {
  tid: string;
  resource_tid?: string;
  data: T;
  author?: string;
  editors?: string[];
  readers?: string[];
  created_at?: number;
  updated_at?: number;
}

/**
 * Flat AND-equality filter for `/app/doc/list` `where`. Each key MUST be a
 * declared level-0 field (level≥1 fields live encrypted and are
 * unfilterable). Values: string | number | boolean | array (array = IN).
 * Object values are rejected by the server (reserved for future `{op,value}`).
 */
export type WhereFilter = Record<string, string | number | boolean | Array<string | number>>;

export interface ListOptions {
  where?: WhereFilter;
  limit?: number;
  offset?: number;
  /** Keyset cursor echoed back as `next_cursor` by a prior page. */
  cursor?: string;
  /** Filter to one author's docs. */
  author?: string;
  /** Include soft-deleted rows (server field `include_deleted`). */
  include_deleted?: boolean;
}
