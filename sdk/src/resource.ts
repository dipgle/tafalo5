// ResourceClient — the spine's data plane. Bound to one resource by its
// `ma` (machine alias). Wraps `/app/doc/*` (CRUD on rows) plus the schema +
// hooks accessors on `/app/resource/*`.
//
// Field-level encryption is transparent here: a field declared level 1/2
// in the schema is encrypted server-side into `data_secret` on write and
// decrypted back on `get`. The SDK never sees ciphertext — you read/write
// the plain field; the server keeps secret fields out of the searchable
// index (including fields stamped by `set_fields` hooks).

import type { HttpCore } from "./http.js";
import type { Doc, FieldDecl, Hook, ListOptions } from "./types.js";

export class ResourceClient<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly http: HttpCore,
    /** Resource machine alias, e.g. "task". */
    readonly ma: string,
  ) {}

  // ---- Docs (rows) ----------------------------------------------------

  /** Create one doc. Resolves its `tid` (use `get()` to read it back). */
  async create(data: T): Promise<{ tid: string; resource_tid: string }> {
    return this.http.post("/app/doc/create", { resource_ma: this.ma, data });
  }

  /** Create many docs in one round-trip. Each item is `{ data, ...acl }`.
   *  `atomic` (default true server-side) = all-or-nothing; pass false for
   *  partial-success import flows. Max 200 items/request. */
  async createBatch(
    items: Array<{ data: T } & DocAcl>,
    opts: { atomic?: boolean } = {},
  ): Promise<{ tids: string[]; count: number; failures?: Array<{ index: number; code: string; msg: string; [k: string]: unknown }> }> {
    return this.http.post("/app/doc/create-batch", {
      resource_ma: this.ma,
      items,
      ...opts,
    });
  }

  /** Fetch one doc by tid (secret fields decrypted). */
  async get(tid: string): Promise<Doc<T>> {
    return this.http.post<Doc<T>>("/app/doc/get", { tid });
  }

  /** List docs, optionally filtered/paged. `where` is a containment +
   *  comparison filter evaluated against `data_indexed` (level-0 fields
   *  only — secret fields are not searchable by design). */
  async list(opts: ListOptions = {}): Promise<Doc<T>[]> {
    return this.http.post<Doc<T>[]>("/app/doc/list", { resource_ma: this.ma, ...opts });
  }

  /**
   * One page of `list()` plus the keyset cursor for the next page. Pass the
   * returned `nextCursor` back as `cursor`; it is `undefined` on the last
   * page. Prefer this over large `offset` values (the server caps offset).
   */
  async listPage(opts: ListOptions = {}): Promise<{ docs: Doc<T>[]; nextCursor?: string }> {
    const env = await this.http.postEnvelope<{ data: Doc<T>[]; next_cursor?: string }>(
      "/app/doc/list",
      { resource_ma: this.ma, ...opts },
    );
    return { docs: env.data ?? [], nextCursor: env.next_cursor };
  }

  /**
   * Bulk-import rows from a `.csv` or `.xlsx` file (Editor, max 20 MiB and
   * 5000 rows). The first row is the header. With `mapping`
   * (`{ "Header text": "field" }`) only mapped columns are imported; without
   * it each header is used as the field name. Rows go through the same
   * validation and hooks as `create()`. With `atomic: true` each chunk of
   * 200 rows is all-or-nothing; otherwise failed rows are reported in
   * `failures` (with their 1-based row number in the file) and the rest are
   * kept. Use `tfl5.resources.previewImport(file)` to infer fields first.
   */
  async importFile(input: {
    file: Blob;
    filename?: string;
    mapping?: Record<string, string>;
    atomic?: boolean;
  }): Promise<ImportResult> {
    const form = new FormData();
    form.append("resource_ma", this.ma);
    if (input.mapping) form.append("mapping", JSON.stringify(input.mapping));
    if (input.atomic !== undefined) form.append("atomic", String(input.atomic));
    const name =
      input.filename ?? (typeof File !== "undefined" && input.file instanceof File ? input.file.name : "import.csv");
    form.append("file", input.file, name);
    return this.http.postForm<ImportResult>("/app/doc/import", form);
  }

  /**
   * Update by tid. NOTE: `data` REPLACES the doc's data wholesale — any
   * field not present is removed (the server re-splits the new object into
   * data_indexed/data_secret). To change a few fields, `get()` first and
   * send the merged object; for an ACL-only change use `setAcl()`.
   */
  async update(tid: string, data: T): Promise<{ tid: string }> {
    return this.http.post("/app/doc/update", { tid, data });
  }

  /** Convenience partial update: get → shallow-merge → full-replace
   *  update. Not atomic (read-modify-write races a concurrent writer). */
  async patch(tid: string, partial: Partial<T>): Promise<{ tid: string }> {
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
  }): Promise<{ tid: string; created: boolean; resource_tid: string }> {
    return this.http.post("/app/doc/upsert", { resource_ma: this.ma, ...input });
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

  /** Update this resource's definition (name/fields/hooks/code guards). To
   *  CREATE a new resource use `tfl5.resources.create(...)` instead.
   *
   *  The `*_code` fields are server-side JS guards run in a QuickJS sandbox
   *  (≤100ms, no network/files) on the matching event. The code sees a global
   *  `ctx` — `ctx.data` (the record, mutable in before_*), `ctx.doc`/`old_doc`,
   *  `ctx.user`, `ctx.now_ms`, and `ctx.reject(msg, code?)` to block the write.
   *  Pass `""` to clear a guard. See docs/data.md (code guards). */
  async putSchema(def: {
    name?: string;
    description?: string;
    /** Allow anonymous share links on this resource. */
    sharing?: boolean;
    /** Resource ACL arrays; each one sent replaces the stored one. */
    readers?: string[];
    editors?: string[];
    noaccess?: string[];
    deletable?: string[];
    fields?: FieldDecl[];
    hooks?: Hook[];
    before_create_code?: string;
    after_create_code?: string;
    before_update_code?: string;
    after_update_code?: string;
  }): Promise<{ tid: string }> {
    const tid = await this.resolveTid();
    return this.http.post("/app/resource/update", { tid, ...def });
  }

  /**
   * Replace some of this resource's own ACL arrays (Manager). Arrays you
   * omit are kept. Role ids may be sent raw (`r-…`); the server stores them
   * bracketed. Who may read the resource's docs is decided here and at the
   * app level — a doc's own arrays only govern writes.
   */
  async setResourceAcl(acl: { readers?: string[]; editors?: string[]; noaccess?: string[]; deletable?: string[] }): Promise<void> {
    await this.putSchema(acl);
  }

  /**
   * Delete this resource definition and its stored docs (Manager). The
   * definition is soft-deleted; its doc storage is dropped. Refused with
   * code `resource_referenced_by_link` while another resource's link field
   * points at it. There is no confirmation step.
   */
  async destroy(): Promise<{ soft_deleted: true }> {
    const tid = await this.resolveTid();
    const out = await this.http.post<{ soft_deleted: true }>("/app/resource/del", { tid });
    this.tidCache = undefined;
    return out;
  }

  /** Declarative-hook accessor (require_fields / set_fields / webhook / wasm). */
  get hooks(): HooksAccessor {
    return new HooksAccessor(this as ResourceClient<Record<string, unknown>>);
  }
}

export interface ImportResult {
  tids: string[];
  count: number;
  requested: number;
  failures?: Array<{ index: number; row: number; code: string; msg: string; [k: string]: unknown }>;
}

export interface DocAcl {
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
  /** Server-side JS code guards (QuickJS sandbox). See {@link ResourceClient.putSchema}. */
  before_create_code?: string;
  after_create_code?: string;
  before_update_code?: string;
  after_update_code?: string;
  [k: string]: unknown;
}

/** Read/replace the hook array on a resource. Hooks live on the resource
 *  definition, so writes go through `/app/resource/update` (keyed by tid). */
export class HooksAccessor {
  // Param is variance-erased: the accessor only touches T-independent
  // schema methods, but ResourceClient<T> is invariant in T.
  constructor(private readonly resource: ResourceClient<Record<string, unknown>>) {}

  /** The resource's hooks. */
  async list(): Promise<Hook[]> {
    const def = await this.resource.getSchema();
    return def.hooks ?? [];
  }

  /** Replace the full hook array (the server stores `resources.hooks`). */
  async set(hooks: Hook[]): Promise<void> {
    await this.resource.putSchema({ hooks });
  }
}
