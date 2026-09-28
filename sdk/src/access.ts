// AccessClient — app-scoped access-control endpoints.
//
// Wraps:
//   POST /app/scope/get              — read scope field_map + caller's bindings
//   POST /app/scope/set              — write scope field_map / bindings (Designer+)
//   POST /app/config/get             — read the app's opaque config blob (Reader+)
//   POST /app/config/patch           — shallow-merge keys into the config blob (Manager+)
//   POST /app/acl/list               — read all six ACL bucket arrays (Manager+)
//   POST /app/acl/set                — replace one ACL bucket (Manager+)
//   POST /app/acl/revoke             — remove one principal from one bucket (Manager+)
//   POST /app/acl/bulk-import        — multi-bucket set in one call (Manager+)
//   POST /app/member/get             — single-user detail: roles + direct grants (Designer+)
//   POST /app/member/set-direct-grants — toggle apps.<arr> direct grants for a user
//   POST /app/role/list-for-user     — full role set a user holds in the app (Manager / self)

import type { HttpCore } from "./http.js";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * A single scope binding: a `{scope, params?, role_code, pii_level?}` entry
 * stored under `apps.acls.scope.bindings[user_tid]`.
 */
export interface ScopeBinding {
  scope: string;
  params?: Record<string, unknown>;
  role_code?: string;
  pii_level?: string;
  [k: string]: unknown;
}

/**
 * The field-map for scope: a resource-keyed object describing which fields are
 * visible per scope level. Shape is opaque to tfl5 core — the tenant defines it.
 */
export type ScopeFieldMap = Record<string, unknown>;

/** Response shape for `scopeGet`. */
export interface ScopeGetResult {
  /** Operator-controlled field visibility config (`apps.acls.scope.field_map`). */
  field_map: ScopeFieldMap;
  /**
   * The CALLER's own bindings (`apps.acls.scope.bindings[caller_tid]`). Only
   * the caller's own slice is returned; Managers see others via admin tooling.
   */
  my_bindings: ScopeBinding[];
}

/** Input for `scopeSet`. All three patch modes are optional; at least one
 *  should be present. Applied in order: field_map → bindings replace →
 *  bindings_patch. */
export interface ScopeSetInput {
  /**
   * Replace the whole `field_map`. Pass `null` to clear it. Omit to leave
   * the existing field_map untouched.
   */
  field_map?: ScopeFieldMap | null;
  /**
   * Replace the ENTIRE `bindings` map. Pass `null` to clear all bindings.
   * Omit to leave bindings untouched.
   */
  bindings?: Record<string, ScopeBinding[]> | null;
  /**
   * Partial bindings update: per-user patch. Each key is a `user_tid`;
   * the value is an array of new bindings (replaces that user's slice) or
   * `null` (deletes all bindings for that user). Omitted keys are preserved.
   */
  bindings_patch?: Record<string, ScopeBinding[] | null>;
}

/** Response shape for `scopeSet`. */
export interface ScopeSetResult {
  /** Total number of users with at least one binding after the write. */
  bindings_count: number;
  /** Number of top-level keys in the field_map after the write. */
  field_map_size: number;
}

// ---------------------------------------------------------------------------
// Config blob
// ---------------------------------------------------------------------------

/** Response shape for `configGet` and `configPatch`. */
export interface AppConfigResult {
  /**
   * The full config blob, or a single key's value when `key` was supplied to
   * `configGet`. The shape is defined by the tenant.
   */
  config: Record<string, unknown> | unknown;
}

/** Input for `configPatch`. Supply either `{key, value}` or `{patch}`. */
export interface ConfigPatchInput {
  /** Set a single top-level key. `value` defaults to `null` when omitted. */
  key?: string;
  /** Value for `key`. */
  value?: unknown;
  /** Shallow-merge multiple keys at once. */
  patch?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ACL buckets
// ---------------------------------------------------------------------------

/**
 * The six ACL bucket names supported by the access-control endpoints.
 * `developers` is a legacy column intentionally absent from these endpoints.
 */
export type AclBucket = "managers" | "designers" | "editors" | "readers" | "deletable" | "noaccess";

/**
 * The six ACL arrays returned by `aclList`, `aclSet`, `aclRevoke`, and
 * `aclBulkImport`. Each entry is a principal token: a `user_tid`, a username,
 * a group tid (`g-…`), or a bracketed role tid (`[r-…]`). The server
 * normalises bare role tids to bracketed form automatically.
 */
export interface AppAclArrays {
  managers: string[];
  designers: string[];
  editors: string[];
  readers: string[];
  deletable: string[];
  noaccess: string[];
}

/** Optional buckets for `aclBulkImport`. Omitted buckets are preserved. */
export type AclBulkGrants = Partial<AppAclArrays>;

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

/** A role summary entry returned inside member detail. */
export interface MemberRole {
  tid: string;
  name: string;
}

/**
 * Single-user detail returned by `memberGet`. Includes the user's profile
 * card, their role assignments, and their direct-grant bucket list.
 */
export interface MemberDetail {
  user_tid: string;
  username: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: number;
  /** Roles the user holds in this app. */
  roles: MemberRole[];
  /**
   * Names of ACL arrays where the user has a direct grant (e.g.
   * `["editors", "readers"]`).
   */
  direct_grants: string[];
  /** True when this user is the app author (owner). */
  is_author: boolean;
  /** Present and `true` when the user's `users` row has been deleted/banned
   *  but their tid still appears in an ACL array. */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/** A role entry returned by `roleListForUser`. */
export interface RoleEntry {
  tid: string;
  name: string;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Wraps tfl5's access-control endpoints.
 *
 * All methods that target a specific app read `app_tid` from the ambient
 * `useApp()` context — do NOT pass it in the inputs.
 *
 * Endpoints:
 *   scopeGet          POST /app/scope/get
 *   scopeSet          POST /app/scope/set
 *   configGet         POST /app/config/get
 *   configPatch       POST /app/config/patch
 *   aclList           POST /app/acl/list
 *   aclSet            POST /app/acl/set
 *   aclRevoke         POST /app/acl/revoke
 *   aclBulkImport     POST /app/acl/bulk-import
 *   memberGet         POST /app/member/get
 *   memberSetDirectGrants  POST /app/member/set-direct-grants
 *   roleListForUser   POST /app/role/list-for-user
 */
export class AccessClient {
  constructor(private readonly http: HttpCore) {}

  // -------------------------------------------------------------------------
  // Scope
  // -------------------------------------------------------------------------

  /**
   * Read the scope config for the current app.
   *
   * Returns `field_map` (the operator-controlled field-visibility config) and
   * `my_bindings` (the caller's own scope bindings). Requires Designer+.
   */
  scopeGet(): Promise<ScopeGetResult> {
    return this.http.post<ScopeGetResult>("/app/scope/get", {});
  }

  /**
   * Write scope config for the current app. Requires Designer+.
   *
   * Three patch modes, all optional, applied in order:
   * - `field_map`       — replace (or clear with `null`) the whole field_map.
   * - `bindings`        — replace (or clear with `null`) all user bindings.
   * - `bindings_patch`  — partial per-user update; set a user's slice or
   *                       pass `null` to delete that user's bindings entirely.
   */
  scopeSet(input: ScopeSetInput): Promise<ScopeSetResult> {
    // The server reads JSON `null` as "field absent", so "clear" is sent as
    // an empty object, which the server stores the same way.
    const body: Record<string, unknown> = { ...input };
    if (input.field_map === null) body["field_map"] = {};
    if (input.bindings === null) body["bindings"] = {};
    return this.http.post<ScopeSetResult>("/app/scope/set", body);
  }

  // -------------------------------------------------------------------------
  // Config blob
  // -------------------------------------------------------------------------

  /**
   * Read the app's opaque tenant config blob. Requires Reader+.
   *
   * @param key Optional top-level key. When supplied, `config` in the result
   *            holds only that key's value (or `null` if absent).
   */
  configGet(key?: string): Promise<AppConfigResult> {
    return this.http.post<AppConfigResult>("/app/config/get", key !== undefined ? { key } : {});
  }

  /**
   * Shallow-merge keys into the app's config blob. Requires Manager+.
   *
   * Supply either `{key, value}` to update a single key or `{patch}` for
   * multiple keys (both may be combined; the explicit `key` wins on overlap).
   * Returns the full updated config blob.
   */
  configPatch(input: ConfigPatchInput): Promise<AppConfigResult> {
    return this.http.post<AppConfigResult>("/app/config/patch", input);
  }

  // -------------------------------------------------------------------------
  // ACL buckets
  // -------------------------------------------------------------------------

  /**
   * Read all six ACL bucket arrays for the current app. Requires Manager+.
   */
  aclList(): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/list", {});
  }

  /**
   * Replace one ACL bucket entirely. Requires Manager+.
   *
   * The server normalises bare role tids (e.g. `r-<uuid>`) to bracketed form
   * (`[r-<uuid>]`) automatically. Returns the updated six-bucket snapshot.
   *
   * @param bucket One of the six valid bucket names.
   * @param members Full replacement membership list.
   */
  aclSet(bucket: AclBucket, members: string[]): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/set", { bucket, members });
  }

  /**
   * Remove one principal from one bucket (idempotent). Requires Manager+.
   *
   * The server normalises the principal the same way it was stored, so passing
   * a bare `r-<uuid>` works even if the stored form is `[r-<uuid>]`. Returns
   * the updated six-bucket snapshot.
   *
   * @param bucket One of the six valid bucket names.
   * @param member Principal token to remove.
   */
  aclRevoke(bucket: AclBucket, member: string): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/revoke", { bucket, member });
  }

  /**
   * Multi-bucket set in one call. Requires Manager+.
   *
   * Omitted buckets are preserved; provided buckets fully replace the existing
   * array. Each bucket is bracket-normalised on the server. Returns the updated
   * six-bucket snapshot.
   */
  aclBulkImport(grants: AclBulkGrants): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/bulk-import", { grants });
  }

  // -------------------------------------------------------------------------
  // Member
  // -------------------------------------------------------------------------

  /**
   * Get the detail card for a single user in the current app. Requires Designer+.
   *
   * Returns their profile, assigned roles, and direct-grant bucket list. Throws
   * `not_found` when the user has no grant in the app (not even a direct array
   * entry) and is not the app author.
   */
  memberGet(userTid: string): Promise<MemberDetail> {
    return this.http.post<MemberDetail>("/app/member/get", { user_tid: userTid });
  }

  /**
   * Toggle direct-grant memberships for a user. Required permission depends on
   * the target bucket: `managers` → Owner only; `designers`/`developers` →
   * Manager+; others → Designer+.
   *
   * Pass `true` to grant and `false` to revoke for each bucket. Omitted buckets
   * are left unchanged. Returns the applied map.
   *
   * @param userTid  The user to modify.
   * @param grants   A map of bucket name → desired membership (true/false).
   */
  memberSetDirectGrants(
    userTid: string,
    grants: Partial<Record<string, boolean>>,
  ): Promise<{ user_tid: string; applied: Record<string, boolean> }> {
    return this.http.post("/app/member/set-direct-grants", { user_tid: userTid, grants });
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  /**
   * Get the full set of roles a user holds in the current app. Requires Manager+
   * when querying another user; a Reader may query their own roles.
   *
   * Role resolution uses the same hydration path as login, so both direct and
   * group-mediated membership are included.
   */
  roleListForUser(userTid: string): Promise<{ roles: RoleEntry[] }> {
    return this.http.post<{ roles: RoleEntry[] }>("/app/role/list-for-user", {
      user_tid: userTid,
    });
  }
}
