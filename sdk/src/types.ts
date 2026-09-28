// Shared wire types for the tfl5 REST contract.
//
// The server always answers a successful call with the envelope
// `{ result: true, data: <payload>, timestamp: <ms> }` and an error with
// `{ code: <machine-code>, msg: <human> }` (see docs/errors.md).
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
  /** Set when the session is missing or expired (some endpoints answer HTTP 200 with it). */
  isSignout?: boolean;
  result?: boolean;
  /**
   * Details some refusals attach: `quota_exceeded` → `{cap, …,
   * refundable_on_delete}`; `token_scope_denied` → `{path, scopes}`; durable
   * `instance_quota` / `tick_deadline` → counts and the deadline. Absent when
   * the server sent none. A few refusals put details at the top level instead
   * (`owns_apps` → `app_tids`), reachable through `Tfl5Error.body`.
   */
  data?: unknown;
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

/**
 * Declarative resource hook, stored on the resource definition.
 *
 * - `require_fields` (before_*): reject the write unless `params.fields` are set.
 * - `set_fields` (after_*): stamp `params.set` onto the committed doc
 *   (secret fields stay encrypted).
 * - `webhook` (after_*): POST the doc to `params.url` in the background.
 * - `wasm` (after_*): call your WASM operator `params.op_id` with action
 *   `params.action` (defaults to the event name).
 *
 * The server does not validate `on[]`: an unknown event name is stored and
 * simply never fires, so use the {@link HookEvent} names exactly.
 */
export interface Hook {
  id: string;
  on: HookEvent[];
  type: "require_fields" | "set_fields" | "webhook" | "wasm";
  params?: Record<string, unknown>;
  when?: Record<string, unknown>;
  msg?: string;
}

/** Doc lifecycle events a hook can fire on (note: `_del`, not `_delete`). */
export type HookEvent =
  | "before_create"
  | "after_create"
  | "before_update"
  | "after_update"
  | "before_del"
  | "after_del";

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
