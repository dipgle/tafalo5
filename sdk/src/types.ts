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
  /**
   * Machine-readable detail about the refusal, when the raising site supplied
   * one. Present on the refusals worth acting on rather than just reporting:
   *
   * - `quota_exceeded` — which cap was hit, e.g.
   *   `{cap:"app_create_rights", rights, created, remaining, refundable_on_delete}`
   *   or `{cap:"user_max_apps", max, used, refundable_on_delete}`. Note the two
   *   caps do not mean the same thing: one is a lifetime counter, the other a
   *   concurrent cap.
   * - `token_scope_denied` — `{path, scopes}`, where `scopes` is the token's
   *   FULL stored list while the message names only the enforceable subset.
   * - durable `instance_quota` / `tick_deadline` — the live/limit counts and
   *   the deadline in ms, which is what a caller needs to back off sensibly.
   *
   * ⚠ Absent means absent. The server omits the key entirely rather than
   * sending `"data": null`, so `"data" in env` is the test — a truthiness
   * check cannot distinguish "no detail" from a detail of `0` or `""`.
   *
   * Typed `unknown` on purpose: the shape is per-refusal-site and open-ended.
   * A union of today's shapes would go stale silently the first time a new
   * site adds one, since every existing call site would still compile.
   */
  data?: unknown;

  /**
   * ⚠ NOT EVERY PAYLOAD ARRIVES IN `data`. Some sites put their detail at the
   * TOP LEVEL of the envelope, as a sibling of `code`/`msg`:
   *
   * - `owns_apps` from `/user/data/erase` carries `app_tids` there
   *   (`crates/routes/src/user.rs`, anchor `"app_tids": owned,`).
   * - the durable refusals `wrong_cell` / `cell_forward_failed` carry
   *   `cell_id` / `base_url` there — see `durable.ts`'s placement helpers.
   * - on the SUCCESS side, the file write paths put `warnings` beside `data`
   *   (`crates/routes/src/file/mod.rs`, anchor
   *   `out["warnings"] = json!([w]);`), which is why `files.ts` reads those
   *   routes through `postFull` / `postFormFull` instead of `post`.
   *
   * `Tfl5Error.body` is the WHOLE parsed envelope, so those fields are
   * present at runtime; reaching them needs a cast, e.g.
   * `(err.body as { app_tids?: string[] }).app_tids`.
   *
   * Deliberately no `[key: string]: unknown` index signature: adding one
   * would make every typo on a declared field compile, which trades a
   * loud error for a silent one.
   */
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
