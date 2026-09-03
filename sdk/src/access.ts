// AccessClient — the incremental ACL + membership admin surface.
//
// Source of truth: crates/routes/src/acl_admin.rs and crates/routes/src/member.rs.
// `/app/acl-set` (see AppsClient.setAcl) takes whole buckets in one shot —
// each supplied array REPLACES its column, omitted ones are preserved — which
// is awkward for an admin UI: to change one name you must read the array,
// splice it and post it back, and you race anyone else editing it. These are
// the surgical equivalents over the same columns.
//
// Endpoints:
//   POST /app/acl/list                 — read the six ACL bucket arrays (Manager)
//   POST /app/acl/set                  — replace ONE bucket (Manager, raised by the ladder)
//   POST /app/acl/revoke               — remove one principal from one bucket (same)
//   POST /app/acl/bulk-import          — several buckets in one call (same)
//   POST /app/role/list-for-user       — every role a user holds here (Manager, or self)
//   POST /app/member/get               — one member's card + roles + grants (Designer)
//   POST /app/member/search            — find a person by username (Designer)
//   POST /app/member/set-direct-grants — toggle raw ACL-array membership (ladder ONLY)
//
// ## The ladder — read this before wrapping any of these in a UI
//
// Writing an ACL bucket is priced by the bucket, not by the endpoint, because
// touching a high-privilege array IS a high-privilege act: a Designer who can
// add itself to `managers` has escalated. The price is
// `strictest(endpoint floor, ladder(buckets touched))`, where the ladder
// (auth.rs:125-127) is:
//
//   managers                  ⇒ Owner
//   designers | developers    ⇒ Manager
//   everything else           ⇒ Designer
//   (no buckets at all        ⇒ Designer — auth.rs:166)
//
// "Owner" means `apps.author` and nobody else. A Manager is NOT an Owner:
// `decide` returns `false` for the Owner level unless the caller is literally
// the author (auth.rs:881-882), so there is no role, group or grant that can
// stand in for it. Only `/app/transfer-ownership` moves it.
//
// ## Delta vs. presence — the trap that silently demands Owner
//
// The two multi-bucket endpoints price the SAME write differently:
//
// - `/app/acl-set` prices the CHANGE. Buckets whose incoming array is
//   set-equal to the stored one after normalisation are not counted
//   (app.rs:1367 + app.rs:1612), so re-posting an unchanged `managers` array
//   is free and a Manager can save the form.
// - `/app/acl/bulk-import` prices PRESENCE. The requirement is computed from
//   the keys the payload CONTAINS (acl_admin.rs:507, `is_some()`), not from
//   what they change, so sending an identical `managers` array still demands
//   Owner.
//
// A "save all six arrays" dialog ported from `/app/acl-set` to
// `bulkImport` therefore starts refusing every Manager, with no diff in the
// data and nothing in the payload to point at. Send only the buckets you mean
// to change — see {@link AccessClient.bulkImport}.

import type { HttpCore } from "./http.js";

// ---- ACL buckets ---------------------------------------------------------

/**
 * The six ACL buckets the `/app/acl/*` endpoints accept
 * (`acl_admin.rs:62-71`). `developers` is retired from THIS surface: passing
 * it to any `/app/acl/*` endpoint is rejected with `unknown_acl_bucket`.
 *
 * It is not gone everywhere, though — see {@link DirectGrantArray}.
 */
export type AclBucket = "managers" | "designers" | "editors" | "readers" | "deletable" | "noaccess";

/**
 * The six arrays every `/app/acl/*` endpoint answers with — `list` and each
 * of the three writers return the same post-write snapshot, so a UI never
 * needs a follow-up read.
 *
 * Each entry is a principal token: a `user_tid` (`u-…`, or legacy `u_…`), a
 * username, a group tid (`g-…`), or a role tid wrapped in brackets (`[r-…]`).
 * The brackets are load-bearing, not cosmetic — the ACL evaluator brackets
 * role tids at compare time, so a bare `r-…` at rest matches NOTHING, and the
 * wrapping is what stops a username from impersonating a role tid. The server
 * normalises bare role tids for you on every write path, so pass whichever
 * form you have.
 */
export interface AppAclArrays {
  managers: string[];
  designers: string[];
  editors: string[];
  readers: string[];
  deletable: string[];
  noaccess: string[];
}

/**
 * Buckets for {@link AccessClient.bulkImport}. Omitted buckets are preserved.
 *
 * ⚠ A key that is PRESENT is priced even when its value is unchanged — see
 * the delta-vs-presence note in this module's header. Omit what you are not
 * changing.
 */
export type AclBulkGrants = Partial<AppAclArrays>;

// ---- Members -------------------------------------------------------------

/**
 * ACL array names accepted by {@link AccessClient.setDirectGrants} and
 * reported in {@link MemberDetail.direct_grants} (`member.rs:81-89`).
 *
 * Seven, not six: this surface still accepts `developers`, and the ladder
 * still prices it at Manager (auth.rs:126). But `decide` — the function every
 * permission gate funnels through — never reads the column
 * (auth.rs:888-894), and `/app/get` does not echo it (app.rs:465). So a write
 * to `developers` succeeds, shows up in `direct_grants`, costs a Manager
 * level to make, and grants the target absolutely nothing. Do not offer it in
 * a UI; treat an existing entry as dead weight.
 */
export type DirectGrantArray = AclBucket | "developers";

/** A role summary as it appears inside a member card. */
export interface MemberRole {
  tid: string;
  name: string;
}

/**
 * One member's card, from `/app/member/get`.
 *
 * PII fields (`display_name`, `phone`, `email`) are decrypted best-effort and
 * come back `null` when absent or undecryptable — a key rotation in flight is
 * not an error here.
 */
export interface MemberDetail {
  user_tid: string;
  username: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  /** Epoch ms; `0` on a stale stub. */
  created_at: number;
  /**
   * Roles the user holds in this app **by direct tid membership only**.
   *
   * ⚠ Not the same set the permission gate sees. This endpoint matches each
   * role's `members` array against the `user_tid` string you passed
   * (`member.rs:224-228`), so a role that lists the person by USERNAME, or
   * that reaches them through a GROUP tid, does not appear here — even
   * though it grants them access. The login-path hydration that the gate
   * actually uses expands username, tid and every group tid before matching
   * (`middleware.rs:766-819`).
   *
   * Use this to render "what was granted directly here". For the authoritative
   * role set, call {@link AccessClient.roleListForUser}, which re-runs that
   * hydration.
   */
  roles: MemberRole[];
  /**
   * Names of the ACL arrays the user sits in directly. Can include
   * `"developers"` — which confers nothing; see {@link DirectGrantArray}.
   */
  direct_grants: DirectGrantArray[];
  /** True when this user is `apps.author`, i.e. the Owner. */
  is_author: boolean;
  /**
   * `true` when the tid is in an ACL array but the `users` row is gone
   * (deleted or banned upstream). Every other field is `null`/`0`. Surfaced
   * deliberately so an admin can strip the dangling reference.
   */
  stale?: boolean;
}

/** One hit from `/app/member/search`. Deliberately thin — no PII beyond the
 *  display name, because the caller has not yet chosen this person. */
export interface MemberSearchHit {
  user_tid: string;
  username: string;
  /** Decrypted display name, or `null` when absent/undecryptable. */
  display_name: string | null;
}

/** Result of {@link AccessClient.setDirectGrants}. `applied` echoes the
 *  buckets that were written and the boolean each was set to. */
export interface SetDirectGrantsResult {
  user_tid: string;
  app_tid: string;
  applied: Partial<Record<DirectGrantArray, boolean>>;
}

// ---- Roles ---------------------------------------------------------------

/** A role entry from `/app/role/list-for-user`. */
export interface RoleEntry {
  tid: string;
  name: string;
  /**
   * Never `null` — the hydration query coalesces a missing description to the
   * empty string (`middleware.rs:814`, `config.rs:1054`). Test it with
   * `if (r.description)`, not `!= null`.
   */
  description: string;
}

// ---- Client --------------------------------------------------------------

export class AccessClient {
  constructor(private readonly http: HttpCore) {}

  // ---- ACL buckets -------------------------------------------------------

  /**
   * Read the six ACL bucket arrays. **Manager** (`acl_admin.rs:291`).
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * Do NOT use the result to work out what the current caller may do. The
   * arrays hold role and group tokens that only the server can resolve, so
   * any client that ranks itself from them ends up with a second, wrong
   * ladder (auth.rs:78-79). Read `my_level` off `/app/get` instead — see
   * {@link AppsClient.get}.
   */
  aclList(): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/list", {});
  }

  /**
   * Replace ONE bucket wholesale. Returns the six-array snapshot after the
   * write (`acl_admin.rs:332-336`).
   *
   * Gate: `strictest(Manager, ladder(bucket))` — so `"managers"` requires
   * **Owner** and everything else requires **Manager** (the endpoint's floor
   * is already above the ladder's Designer tier).
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * `members` fully replaces the bucket; pass `[]` to clear it. Bare role
   * tids are bracket-normalised server-side. Refusals: see
   * {@link AccessClient.bulkImport} — the same three apply here.
   */
  aclSet(bucket: AclBucket, members: string[]): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/set", { bucket, members });
  }

  /**
   * Remove one principal from one bucket. Idempotent — removing somebody who
   * is not there succeeds and changes nothing (`acl_admin.rs:408`).
   *
   * Gate: identical to {@link AccessClient.aclSet}, and for the same reason —
   * taking somebody OUT of `managers` is as privileged as putting them in, so
   * a revoke on that bucket also requires **Owner**.
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * `member` is normalised the same way it was stored, so a bare `r-…` does
   * revoke a role stored as `[r-…]` rather than silently no-opping.
   */
  aclRevoke(bucket: AclBucket, member: string): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/revoke", { bucket, member });
  }

  /**
   * Write several buckets in one call. Omitted buckets are preserved;
   * provided buckets are fully replaced (`acl_admin.rs:517`).
   *
   * Gate: `strictest(Manager, ladder(keys present in grants))`.
   *
   * ⚠ **Presence, not change.** Unlike `/app/acl-set`
   * ({@link AppsClient.setAcl}), which compares each incoming array against
   * the stored one and charges only for the buckets that actually differ,
   * this endpoint charges for every key the payload carries. `{managers:
   * [...unchanged]}` demands **Owner** here and is free there. Send only the
   * buckets you are changing.
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * Refusals shared by all three writers, each thrown as a `BadRequestError`
   * carrying the `code`:
   * - `acl_array_too_large` — any resulting array over 5000 entries
   *   (`acl_admin.rs:59`, `:183`). Use roles or groups for bigger cohorts.
   * - `unknown_acl_bucket` — a bucket name outside the six
   *   (`acl_admin.rs:325`); `developers` lands here.
   * - `acl_token_unknown` — an entry naming no person, role or group
   *   (`acl_tokens.rs:161`). Checked only against what the call ADDS, so a
   *   stale token already at rest does not block an unrelated edit; blanks
   *   and the `G_author` sentinel are skipped. The offending entries come
   *   back in a top-level `unknown` array on the error body.
   *
   * All three writers also run a lock-out guard — see
   * {@link AppsClient.setAcl} for what it does and does not protect.
   */
  bulkImport(grants: AclBulkGrants): Promise<AppAclArrays> {
    return this.http.post<AppAclArrays>("/app/acl/bulk-import", { grants });
  }

  // ---- Members -----------------------------------------------------------

  /**
   * One member's card, with their roles and direct grants. **Designer**
   * (`member.rs:579`).
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * Throws `NotFoundError` when the user holds no role, sits in no ACL array
   * and is not the author — the endpoint answers about members of THIS app,
   * so a hollow card would read as "this person exists here" when they do
   * not. A tid that is in an array but whose account is gone comes back as a
   * {@link MemberDetail.stale} stub instead.
   */
  memberGet(userTid: string): Promise<MemberDetail> {
    return this.http.post<MemberDetail>("/app/member/get", { user_tid: userTid });
  }

  /**
   * Find a person by username. **Designer** (`member.rs:505`).
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * This is the only person-search an ordinary app owner can reach. The
   * platform-admin directory search answers `access_denied` to everyone
   * else, so this is what an "add a member" picker has to call.
   *
   * Semantics worth knowing before you build the picker on it:
   * - **Username only.** Display names, emails and phone numbers are
   *   encrypted at rest and are not searchable (`member.rs:531`). Someone
   *   who knows a colleague only by their real name will find nothing.
   * - **Global, not app-scoped.** It searches every account on the platform,
   *   which is the point — you are looking for somebody to ADD. Use
   *   `/app/member/list` (with its own `search`) to narrow people already in
   *   the app.
   * - **Banned accounts are excluded** (`ban = 0`), so a hit is always a
   *   usable grant target.
   * - `query` must be at least 2 characters after trimming, else
   *   `query_too_short` (`member.rs:70`, `:508`, thrown as
   *   `BadRequestError`). A blank query is never treated as "match
   *   everything", and `%` is escaped before it reaches the `LIKE`
   *   (`member.rs:526`) — so `"%%"` clears the length check and still
   *   matches nothing.
   * - `limit` defaults to 10 and is clamped to 25. The server echoes the
   *   clamped value as a sibling of `data`, which this method's unwrapping
   *   drops — apply `Math.min(limit ?? 10, 25)` if you need to show it.
   */
  memberSearch(query: string, limit?: number): Promise<MemberSearchHit[]> {
    return this.http.post<MemberSearchHit[]>(
      "/app/member/search",
      limit === undefined ? { query } : { query, limit },
    );
  }

  /**
   * Toggle a user's DIRECT membership in the raw ACL arrays — `true` grants,
   * `false` revokes, omitted arrays are untouched (`member.rs:792-793`).
   *
   * ⚠ **Gate: the ladder alone, with no Manager floor.** This is the one ACL
   * writer that does not sit behind `strictest(Manager, …)`, so the level it
   * demands is exactly what the ladder says and can be lower than every
   * `/app/acl/*` endpoint:
   *
   *   `{readers: true}`   ⇒ **Designer**
   *   `{designers: true}` ⇒ **Manager**
   *   `{managers: true}`  ⇒ **Owner**
   *   `{}`                ⇒ **Designer** (and applies nothing)
   *
   * So a Designer can grant and revoke `editors`, `readers`, `deletable`
   * **and `noaccess`** here, on anybody. Putting a Manager into `noaccess`
   * vetoes them at every level (auth.rs:885). Grant Designer with that in
   * mind; prefer `/app/acl/*` for ACL editing, which has a Manager floor and
   * a lock-out guard this endpoint does not run.
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * Refusals (all `BadRequestError`, `code` preserved):
   * - `validation_invalid` — an array name outside the seven
   *   (`member.rs:777`), or an empty/whitespace `user_tid`
   *   (`member.rs:810`).
   * - `user_not_found` — the subject does not resolve, checked **only when
   *   the call grants something** (`member.rs:819`). A pure revoke works
   *   against a tid whose account is gone, which is exactly the entry you
   *   most need to be able to clear. Before this check existed, granting to
   *   a nonexistent user answered `result:true` and spliced a dead entry
   *   into a live ACL.
   *
   * The subject is matched on either `users.tid` or `users.username`, and is
   * trimmed before it is stored so `" u-abc "` cannot become a second entry
   * that looks like the same member.
   */
  setDirectGrants(
    userTid: string,
    grants: Partial<Record<DirectGrantArray, boolean>>,
  ): Promise<SetDirectGrantsResult> {
    return this.http.post<SetDirectGrantsResult>("/app/member/set-direct-grants", {
      user_tid: userTid,
      grants,
    });
  }

  // ---- Roles -------------------------------------------------------------

  /**
   * Every role a user holds in this app. **Manager — or the caller asking
   * about themselves** (`acl_admin.rs:54`).
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * The gate is two-stage (`acl_admin.rs:609`, `:617`): Reader first, which
   * proves the caller belongs to the app at all, then Manager unless
   * `userTid` resolves to the caller. Self-introspection is always allowed —
   * a user may learn their own roles — and both tid spellings (`u-…` and
   * legacy `u_…`) are canonicalised before the self comparison, so either
   * form is recognised.
   *
   * Resolution re-runs the same hydration the login path uses, so the answer
   * cannot diverge from what the ACL evaluator sees: direct membership and
   * group-mediated membership both count.
   *
   * A `userTid` that names no live account returns an empty `roles` array
   * rather than throwing — past the Manager gate there is nothing to leak,
   * and an empty set is the honest answer.
   */
  roleListForUser(userTid: string): Promise<{ roles: RoleEntry[] }> {
    return this.http.post<{ roles: RoleEntry[] }>("/app/role/list-for-user", {
      user_tid: userTid,
    });
  }
}
