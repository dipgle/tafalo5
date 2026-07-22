// ResourceClient — the spine's data plane. Bound to one resource by its
// `ma` (machine alias). Wraps `/app/doc/*` (CRUD on rows) plus the schema +
// hooks accessors on `/app/resource/*`.
//
// Field-level encryption is transparent here: a field declared level 1/2
// in the schema is encrypted server-side into `data_secret` on write and
// decrypted back on `get`. The SDK never sees ciphertext — you read/write
// the plain field; the server enforces the column split (and, post-fix,
// even `set_fields` hooks honor it).

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

  /** Update this resource's definition (name/fields/hooks) and/or its
   *  per-RESOURCE-TYPE ACL arrays. To CREATE a new resource use
   *  `tfl5.createResource(...)` instead.
   *
   *  Resource-ACL (`readers/editors/deletable/noaccess`) gates every
   *  `/app/doc/*` op on this resource TYPE — a coarser layer than per-doc ACL
   *  (see acl-model.md). Omit an array to preserve it; pass `[]` to clear.
   *  (`managers`/`designers`/`authors` are NOT enforced as a doc gate — only the
   *  four arrays here are; see acl-model.md "Resource-level ACL".) */
  async putSchema(
    def: { name?: string; fields?: FieldDecl[]; hooks?: Hook[] } & ResourceAcl,
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
  [k: string]: unknown;
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
