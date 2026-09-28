// ResourcesClient — app-level operations on resource definitions
// (`/app/resource/*`). For the docs inside one resource use
// `tfl5.resource(ma)`.

import type { HttpCore } from "./http.js";
import type { FieldDecl, Hook } from "./types.js";

export interface ResourceSummary {
  tid: string;
  ma: string;
  name?: string;
  [k: string]: unknown;
}

/** One resource's health row from `constraints()`. */
export interface ResourceConstraint {
  tid: string;
  ma: string;
  name: string;
  description: string | null;
  doc_count: number;
  share_count: number;
  hook_count: number;
  field_count: number;
  acl_user_count: number;
  acl_breakdown: {
    managers: number;
    designers: number;
    authors: number;
    editors: number;
    readers: number;
    deletable: number;
    noaccess: number;
  };
  storage_table: string;
  updated_at: number;
  /** `empty` (0 docs) · `stale` (not updated in 30 days) · `no_acl`. */
  flags: Array<"empty" | "stale" | "no_acl">;
  sharing: boolean;
  status: number;
}

/** Output of `previewImport()`: feed `fields` to `create()` and `mapping` to `importFile()`. */
export interface InferredSchema {
  fields: Array<{ field: string; name: string; validator: string }>;
  mapping: Record<string, string>;
  /** Rows used for type inference (at most 200). */
  sampled: number;
  total: number;
}

export interface NewResource {
  ma: string;
  name: string;
  description?: string;
  fields?: FieldDecl[];
  hooks?: Hook[];
  readers?: string[];
  editors?: string[];
  noaccess?: string[];
  deletable?: string[];
  audit_writes?: boolean;
}

export class ResourcesClient {
  constructor(private readonly http: HttpCore) {}

  /** List the scoped app's resources. */
  list(): Promise<ResourceSummary[]> {
    return this.http.post<ResourceSummary[]>("/app/resource/list", {});
  }

  /**
   * Define a new resource (Manager). `ma` is the alias `tfl5.resource(ma)`
   * uses. Leave the ACL arrays out for no restriction beyond the app's
   * ACL; change them later with `tfl5.resource(ma).setResourceAcl()`.
   * `audit_writes: true` records an audit row for every doc
   * create/update/delete.
   */
  create(input: NewResource): Promise<{ tid: string; ma: string }> {
    return this.http.post("/app/resource/create", input);
  }

  /**
   * Per-resource usage and ACL overview (Editor), plus `orphans`: deleted
   * resources whose doc storage still holds rows. Rate-limited to 30 calls
   * per minute per app (code `rate_limit_exceeded`).
   */
  constraints(): Promise<{
    resources: ResourceConstraint[];
    orphans: Array<{ tid: string; name: string; doc_count: number; storage_table: string }>;
  }> {
    return this.http.post("/app/resource/constraints", {});
  }

  /**
   * Drop the leftover storage of an already-deleted resource (Manager).
   * Refused with code `resource_not_deleted` (409) for a live resource.
   * Idempotent: returns `dropped_rows: 0` once the storage is gone.
   */
  dropOrphan(tid: string): Promise<{ dropped_rows: number }> {
    return this.http.post("/app/resource/orphan-drop", { tid });
  }

  /**
   * Infer a field list from a `.csv` / `.xlsx` file without writing
   * anything (Editor, max 20 MiB).
   */
  previewImport(file: Blob, filename?: string): Promise<InferredSchema> {
    const form = new FormData();
    const name =
      filename ?? (typeof File !== "undefined" && file instanceof File ? file.name : "import.csv");
    form.append("file", file, name);
    return this.http.postForm<InferredSchema>("/app/doc/import-preview", form);
  }
}
