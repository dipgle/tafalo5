// ResourceClient — the spine's data plane. Bound to one resource by its
// `ma` (machine alias). Wraps `/app/doc/*` (CRUD on rows) plus the schema +
// hooks accessors on `/app/resource/*`.
//
// Field-level encryption is transparent here: a field declared level 1/2
// in the schema is encrypted server-side into `data_secret` on write and
// decrypted back on `get`. The SDK never sees ciphertext — you read/write
// the plain field; the server enforces the column split (and, post-fix,
// even `set_fields` hooks honor it).
//
// ⚠ NO GRACEFUL DEGRADATION on decrypt failure, and the blast radius is the
// WHOLE response, not the one bad cell. Server-side, `decrypt_secret_blob`
// (doc_fields.rs:181-223) turns any decrypt failure (corrupt ciphertext, a
// master-key rotation whose backfill hasn't finished, ...) into a bare
// `AppError::Internal`, which propagates through an unguarded `?` inside
// `row_to_json` (doc.rs:1719-1748). That function runs once per row in
// `list()`'s loop AND once for `get()` — with no per-row catch either
// place. So ONE corrupted / currently-unopenable level-1/2 cell aborts the
// ENTIRE call as HTTP 500 `{"code":"internal"}`, potentially discarding
// hundreds of unrelated rows on the same page. This is NOT the account-PII
// contract: `/user/profile` degrades per-field via an `unreadable` array
// instead of failing the whole request. Documents did not get that
// treatment — do not model a `data_secret` field as "decrypts to null on
// failure like account PII does"; model `get()`/`list()` as able to throw
// outright whenever level-1/2 data is on the page.

import type { HttpCore } from "./http.js";
import type { Doc, FieldDecl, Hook, ListOptions } from "./types.js";

export class ResourceClient<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly http: HttpCore,
    /** Resource machine alias, e.g. "task". */
    readonly ma: string,
  ) {}

  // ---- Docs (rows) ----------------------------------------------------

  /** Create one doc. Returns the new doc (with its `tid`). */
  async create(data: T): Promise<Doc<T>> {
    return this.http.post<Doc<T>>("/app/doc/create", { resource_ma: this.ma, data });
  }

  /** Create many docs in one round-trip. Each item is `{ data, ...acl }`.
   *  `atomic` (default true server-side) = all-or-nothing; pass false for
   *  partial-success import flows. Max 200 items/request. */
  async createBatch(
    items: Array<{ data: T } & DocAcl>,
    opts: { atomic?: boolean } = {},
  ): Promise<Doc<T>[]> {
    return this.http.post<Doc<T>[]>("/app/doc/create-batch", {
      resource_ma: this.ma,
      items,
      ...opts,
    });
  }

  /** Fetch one doc by tid (secret fields decrypted). Throws HTTP 500
   *  `internal` if a level-1/2 field on this row can't be decrypted — see
   *  the module header; there is no partial/degraded result. */
  async get(tid: string): Promise<Doc<T>> {
    return this.http.post<Doc<T>>("/app/doc/get", { tid });
  }

  /** List docs, optionally filtered/paged. `where` is a containment +
   *  comparison filter evaluated against `data_indexed` (level-0 fields
   *  only — secret fields are not searchable by design). NOTE: if ANY row
   *  in the page carries a level-1/2 field that fails to decrypt, the WHOLE
   *  call throws HTTP 500 `internal` — see the module header. There is no
   *  per-row skip; one bad cell can take down an otherwise-healthy page. */
  async list(opts: ListOptions = {}): Promise<Doc<T>[]> {
    return this.http.post<Doc<T>[]>("/app/doc/list", { resource_ma: this.ma, ...opts });
  }

  /**
   * Update by tid. NOTE: `data` REPLACES the doc's data wholesale — any
   * field not present is removed (the server re-splits the new object into
   * data_indexed/data_secret). To change a few fields, `get()` first and
   * send the merged object; for an ACL-only change use `setAcl()`.
   */
  async update(tid: string, data: T): Promise<Doc<T>> {
    return this.http.post<Doc<T>>("/app/doc/update", { tid, data });
  }

  /** Convenience partial update: get → shallow-merge → full-replace
   *  update. Not atomic (read-modify-write races a concurrent writer). */
  async patch(tid: string, partial: Partial<T>): Promise<Doc<T>> {
    const cur = await this.get(tid);
    return this.update(tid, { ...cur.data, ...partial } as T);
  }

  /**
   * Insert-or-update. `match_on` is a flat dict of LEVEL-0 fields used to
   * find an existing row via JSONB containment — it MUST resolve to a
   * unique row (the server rejects a match of >1). Secret fields cannot be
   * matched on. Omit `match_on` (or match nothing) → insert.
   */
  async upsert(input: {
    match_on?: Record<string, unknown>;
    data: T;
    editors?: string[];
    readers?: string[];
    deletable?: string[];
    noaccess?: string[];
  }): Promise<Doc<T>> {
    return this.http.post<Doc<T>>("/app/doc/upsert", { resource_ma: this.ma, ...input });
  }

  /** Soft-delete a doc. */
  async del(tid: string): Promise<void> {
    await this.http.post("/app/doc/del", { tid });
  }

  /** Set per-doc ACL arrays (editors/readers/deletable/noaccess). */
  async setAcl(tid: string, acl: DocAcl): Promise<void> {
    await this.http.post("/app/doc/acl-set", { tid, ...acl });
  }

  // ---- Schema + hooks (control plane) ---------------------------------
  //
  // The schema endpoints are keyed by resource *tid*, but a ResourceClient
  // is addressed by *ma*. We resolve ma→tid once via /app/resource/list and
  // cache it. (Docs endpoints take `resource_ma` directly, so they skip
  // this.)

  private tidCache?: string;

  /** Resolve this resource's tid from its ma (cached). */
  async resolveTid(): Promise<string> {
    if (this.tidCache) return this.tidCache;
    const rows = await this.http.post<Array<{ tid: string; ma: string }>>(
      "/app/resource/list",
      {},
    );
    const match = rows.find((r) => r.ma === this.ma);
    if (!match) throw new Error(`@tfl5/sdk: resource ma="${this.ma}" not found`);
    this.tidCache = match.tid;
    return match.tid;
  }

  /** Get this resource's definition (fields, hooks, ...). */
  async getSchema(): Promise<ResourceDef> {
    const tid = await this.resolveTid();
    return this.http.post<ResourceDef>("/app/resource/get", { tid });
  }

  /** Update this resource's definition (name/fields/hooks/code guards)
   *  and/or its per-RESOURCE-TYPE ACL arrays. To CREATE a new resource use
   *  `tfl5.createResource(...)` instead.
   *
   *  The `*_code` fields are server-side JS guards run in a QuickJS sandbox
   *  (≤100ms wall clock, ≤16MiB heap, no network/files) on the matching doc
   *  lifecycle event (hooks.rs). The code sees one global, `ctx`:
   *  `ctx.event`, `ctx.data` (the incoming payload — mutable in before_*),
   *  `ctx.doc`/`ctx.old_doc` (current row / pre-update snapshot), `ctx.user`,
   *  `ctx.resource`, `ctx.app`, `ctx.now_ms`, and `ctx.reject(msg, code?)` to
   *  block the write (surfaces as `code: "hook_reject"`). `after_*` hooks are
   *  side-effect only — their return value is ignored. Pass `""` to clear a
   *  guard; omit to leave it unchanged. See api-reference.md "JS code hooks"
   *  for the full ABI.
   *
   *  Resource-ACL (`readers/editors/deletable/noaccess`) gates every
   *  `/app/doc/*` op on this resource TYPE — a coarser layer than per-doc ACL
   *  (see acl-model.md). Omit an array to preserve it; pass `[]` to clear.
   *  (`managers`/`designers`/`authors` are NOT enforced as a doc gate — only the
   *  four arrays here are; see acl-model.md "Resource-level ACL".) */
  async putSchema(
    def: {
      name?: string;
      fields?: FieldDecl[];
      hooks?: Hook[];
      /** JS guard run before a create; can mutate `ctx.data` or `ctx.reject(...)`. */
      before_create_code?: string;
      /** JS guard run after a create; side-effect only. */
      after_create_code?: string;
      /** JS guard run before an update; can mutate `ctx.data` or `ctx.reject(...)`. */
      before_update_code?: string;
      /** JS guard run after an update; side-effect only. */
      after_update_code?: string;
    } & ResourceAcl,
  ): Promise<ResourceDef> {
    const tid = await this.resolveTid();
    return this.http.post<ResourceDef>("/app/resource/update", { tid, ...def });
  }

  /** Convenience: set only this resource's ACL arrays (leaves schema/hooks). */
  async setResourceAcl(acl: ResourceAcl): Promise<ResourceDef> {
    return this.putSchema(acl);
  }

  /** Declarative-hook accessor (require_fields / set_fields / webhook). */
  get hooks(): HooksAccessor {
    return new HooksAccessor(this as ResourceClient<Record<string, unknown>>);
  }

  // ---- Resource-type lifecycle + storage cleanup -----------------------
  //
  // `/app/resource/del`, `/app/resource/constraints` and
  // `/app/resource/orphan-drop` (resource.rs:50-52). Without these, cleaning
  // up storage after deleting a resource type means hand-rolling a raw POST.

  /**
   * Soft-delete THIS resource TYPE — the whole schema plus every row it
   * owns, not a single doc (for that, see {@link ResourceClient.del}).
   * Manager on the app.
   *
   * Refused with `resource_referenced_by_link` (HTTP 400) while another
   * live resource has a `link`/`multilink` field pointing at this one —
   * remove or repoint that field first. If the physical storage reclaim
   * fails, the delete still succeeds (`result:true`) and this resource
   * shows up under `orphans` in {@link ResourceClient.constraints}; use
   * {@link ResourceClient.orphanDrop} to finish that cleanup.
   */
  async deleteType(): Promise<void> {
    const tid = await this.resolveTid();
    await this.http.post("/app/resource/del", { tid });
  }

  /**
   * App-wide resource-constraints dashboard: per-resource-type roster and
   * storage counts, plus the list of soft-deleted types whose doc storage
   * was never reclaimed (`orphans`). Editor on the app — the response
   * exposes ACL roster sizes and storage-table identifiers, which Reader
   * should not see.
   *
   * Per-tenant rate-limited (30/min, keyed by `app_tid`) — a burst throws
   * `RateLimitError` (HTTP 429, code `rate_limit_exceeded`) with
   * `retryAfter` set.
   *
   * NOTE: the result covers EVERY resource type in the scoped app, not
   * just `this.ma` — it lives on `ResourceClient` because that's where
   * `/app/resource/*` + the app scope already meet, not because it's
   * specific to one resource.
   */
  async constraints(): Promise<ResourceConstraints> {
    return this.http.post<ResourceConstraints>("/app/resource/constraints", {});
  }

  /**
   * Finish an interrupted storage reclaim for an already-soft-deleted
   * resource type. Manager on the app. Idempotent — re-running after the
   * storage is already gone returns `dropped_rows: 0`.
   *
   * Refused with `resource_not_deleted` (HTTP 409, not 200) if the target
   * is still LIVE — this endpoint only finishes a cleanup
   * {@link ResourceClient.deleteType} already started; it can never touch
   * a live resource's data.
   *
   * @param tid Resource-type tid to reclaim, typically taken from
   *   {@link ResourceConstraints.orphans}. Omit to target THIS client's own
   *   resource (the tid `resolveTid()`/`deleteType()` already cached) — the
   *   common case of cleaning up right after deleting it.
   */
  async orphanDrop(tid?: string): Promise<{ dropped_rows: number }> {
    const target = tid ?? (await this.resolveTid());
    return this.http.post<{ dropped_rows: number }>("/app/resource/orphan-drop", {
      tid: target,
    });
  }
}

export interface DocAcl {
  editors?: string[];
  readers?: string[];
  deletable?: string[];
  noaccess?: string[];
}

/** Per-resource-type ACL arrays enforced on `/app/doc/*` (the four the server
 *  actually gates on — see acl-model.md "Resource-level ACL"). */
export interface ResourceAcl {
  editors?: string[];
  readers?: string[];
  deletable?: string[];
  noaccess?: string[];
}

export interface ResourceDef {
  tid?: string;
  ma: string;
  name?: string;
  fields?: FieldDecl[];
  hooks?: Hook[];
  /** Server-side JS guards (QuickJS sandbox). See {@link ResourceClient.putSchema}. */
  before_create_code?: string;
  after_create_code?: string;
  before_update_code?: string;
  after_update_code?: string;
  [k: string]: unknown;
}

/** Per-role ACL roster sizes for one resource, as returned by
 *  {@link ResourceClient.constraints}. */
export interface ResourceAclBreakdown {
  managers: number;
  designers: number;
  authors: number;
  editors: number;
  readers: number;
  deletable: number;
  noaccess: number;
}

/** A dashboard heads-up on one resource type. `flags` calls out things
 *  worth an operator's attention: `"empty"` (no docs), `"stale"` (has docs,
 *  none touched in 30 days) and `"no_acl"` (nobody rostered on any of the
 *  five roster arrays). */
export interface ResourceConstraintEntry {
  tid: string;
  ma: string;
  name: string;
  description: string | null;
  doc_count: number;
  share_count: number;
  hook_count: number;
  field_count: number;
  acl_user_count: number;
  acl_breakdown: ResourceAclBreakdown;
  storage_table: string;
  updated_at: number;
  flags: Array<"empty" | "stale" | "no_acl">;
  sharing: boolean;
  status: number;
}

/** A soft-deleted resource type whose doc storage was never reclaimed —
 *  see {@link ResourceClient.orphanDrop}. */
export interface ResourceOrphan {
  tid: string;
  name: string;
  doc_count: number;
  storage_table: string;
}

/** Result of {@link ResourceClient.constraints}. */
export interface ResourceConstraints {
  resources: ResourceConstraintEntry[];
  orphans: ResourceOrphan[];
}

/** Read/replace the hook array on a resource. Hooks live on the resource
 *  definition, so writes go through `/app/resource/update` (keyed by tid). */
export class HooksAccessor {
  // Param is variance-erased: the accessor only touches T-independent
  // schema methods, but ResourceClient<T> is invariant in T.
  constructor(private readonly resource: ResourceClient<Record<string, unknown>>) {}

  async list(): Promise<Hook[]> {
    const def = await this.resource.getSchema();
    return def.hooks ?? [];
  }

  /** Replace the full hook array (the server stores `resources.hooks`). */
  async set(hooks: Hook[]): Promise<void> {
    await this.resource.putSchema({ hooks });
  }
}
