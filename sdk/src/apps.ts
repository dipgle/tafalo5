// AppsClient — the spine root (`apps`) + membership plane.
//
// `/app/update` is dual-purpose: a body WITHOUT `tid` creates a new app;
// WITH `tid` it edits. The SIX-array ACL
// (managers/designers/editors/readers/deletable/noaccess) is set via
// `/app/acl-set`; `AccessClient` wraps the incremental `/app/acl/*` surface
// over the same columns. Members are users mapped into per-app roles.

import type { HttpCore } from "./http.js";

/** Domain allowance on `/app/get`. `null` on the app row when it could not
 *  be resolved — the server reports the failure rather than guessing a
 *  number (app.rs:449). */
export interface DomainsQuota {
  max: number;
  used: number;
}

/** The caller's own permission level on an app. Exactly the five values
 *  `AppPermLevel::as_str` emits (auth.rs:178-182). */
export type AppPermLevelName = "owner" | "manager" | "designer" | "editor" | "reader";

export interface AppConfig {
  tid: string;
  name?: string;
  description?: string;
  icon?: string;
  /** `apps.author` — the app's Owner. */
  author?: string;
  /**
   * **What THIS caller may do here** — read this instead of inferring a level
   * from the ACL arrays. See {@link AppsClient.get}.
   */
  my_level?: AppPermLevelName;
  /** SPA shell path, relative to the app's `public/` root; `null` when unset. */
  single_page?: string | null;
  /** The app's own 404 page, relative to `public/`; `null` when unset.
   *  Set it through {@link AppsClient.update}. */
  error_page?: string | null;
  /** `{max, used}`, or `null` when the quota could not be resolved. */
  domains_quota?: DomainsQuota | null;
  /** Soft-delete stamp, epoch ms; `0` means live. */
  deleted_at?: number;
  [k: string]: unknown;
}

/**
 * The app's six ACL buckets. Omit a key to preserve it; pass `[]` to clear.
 *
 * ⚠ The index signature below is a convenience for spreading, not a licence
 * to invent buckets. `/app/acl-set` does not deserialize `developers` at all
 * (app.rs:1296), and because serde's unknown-field rejection is off, sending
 * it is **silently dropped**: the call answers `result:true` and the array is
 * untouched. `/app/get` does not echo it either (app.rs:465). If you need to
 * write that column at all, the only endpoint that still accepts it is
 * `/app/member/set-direct-grants` — and nothing reads it. See
 * `AccessClient`'s `DirectGrantArray`.
 */
export interface AppAcl {
  managers?: string[];
  designers?: string[];
  editors?: string[];
  readers?: string[];
  deletable?: string[];
  noaccess?: string[];
  [k: string]: string[] | undefined;
}

export class AppsClient {
  constructor(private readonly http: HttpCore) {}

  /** Apps the current user belongs to. */
  list(): Promise<AppConfig[]> {
    return this.http.post<AppConfig[]>("/app/list", {});
  }

  /**
   * Fetch one app's config, keyed by `tid`.
   *
   * The response **does** include all six ACL arrays (app.rs:463-471), plus
   * `author`, `error_page`, `domains_quota` and `my_level`.
   *
   * ## Use `my_level`, not the ACL arrays
   *
   * `my_level` (app.rs:460) is the level THIS caller holds here — one of
   * `"owner" | "manager" | "designer" | "editor" | "reader"`. It is computed
   * by walking `decide`, the same function every permission gate calls
   * (auth.rs:88), in descending order, so the answer a screen gets can never
   * disagree with the answer an endpoint gives.
   *
   * It exists precisely so a client stops deriving its level from the ACL
   * arrays, which **cannot be done correctly** (auth.rs:78-79): those arrays
   * hold role and group tokens (`[r-…]`, `g-…`) that only the server can
   * resolve, so a front-end that ranks itself from them builds a second,
   * wrong ladder. The measured cost of doing it that way was a Roles tab
   * fetching Manager-only data for every viewer and rendering "Failed to
   * load", and a Domains screen offering an Owner-only action to a Manager
   * that answered "Access denied".
   *
   * Gate a control on `my_level`; use the arrays only to render who has
   * access.
   */
  get(appTid: string): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/get", { tid: appTid });
  }

  /** Create a new app (omit `tid`). Only name/description/icon are honored
   *  in `data` — ACL fields here are REJECTED (use `setAcl`). */
  create(data: { name?: string; description?: string; icon?: string }): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/update", { data });
  }

  /**
   * Edit an existing app. **Manager** (app.rs:1146). `tid` is a TOP-LEVEL
   * field; ACL changes go through {@link setAcl} — sending an ACL array here
   * is rejected with `app_update_no_acl_fields` rather than silently dropped.
   *
   * `single_page` and `error_page` are **tri-state** (app.rs:1218-1226):
   * omit the key to preserve the current value, pass a path to set it, or
   * pass `""` to clear it. `null` is not the clear signal — `""` is.
   */
  update(
    tid: string,
    data: {
      name?: string;
      description?: string;
      icon?: string;
      /** SPA shell path relative to `public/`; `""` clears. */
      single_page?: string;
      /** 404 page path relative to `public/`; `""` clears. */
      error_page?: string;
    },
  ): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/update", { tid, data });
  }

  del(appTid: string): Promise<void> {
    return this.http.post("/app/del", { tid: appTid }).then(() => undefined);
  }

  /**
   * Hand the app to somebody else. **Owner only** (app.rs:2006) — a Manager
   * does not suffice.
   *
   * The new owner must exist and not be banned. On success `apps.author`
   * flips, the new owner is added to `managers` defensively, and the previous
   * owner is removed from `managers` unless `keepOldAsManager` is set. Writes
   * an append-only `app_ownership_log` row plus an audit row.
   *
   * The wire field is `new_owner_tid` (app.rs:1989) — required, with no serde
   * alias and no default. This method previously sent `to`, which the server
   * has never accepted, so the call could not succeed in any version.
   */
  transferOwnership(
    appTid: string,
    toUserTid: string,
    opts: {
      /** Keep the outgoing owner in `managers` during the handover.
       *  Defaults to false — a clean handover. */
      keepOldAsManager?: boolean;
      /** Free-text reason, recorded in the ownership log. */
      reason?: string;
    } = {},
  ): Promise<void> {
    return this.http
      .post("/app/transfer-ownership", {
        app_tid: appTid,
        new_owner_tid: toUserTid,
        ...(opts.keepOldAsManager !== undefined
          ? { keep_old_as_manager: opts.keepOldAsManager }
          : {}),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      })
      .then(() => undefined);
  }

  // ---- ACL + members -------------------------------------------------

  /**
   * Replace the app's six ACL arrays in one call. Omit a bucket to preserve
   * it; pass `[]` to clear it.
   *
   * ## The gate is not a flat Manager — it is a ladder
   *
   * The required level is `strictest(Manager, ladder(buckets touched))`,
   * where the ladder (auth.rs:125-127) is:
   *
   *   `managers`               ⇒ **Owner**
   *   `designers`/`developers` ⇒ **Manager**
   *   everything else          ⇒ **Designer**
   *   (no buckets at all       ⇒ Designer — auth.rs:166)
   *
   * Because this endpoint's own floor is Manager, the practical effect is:
   * touching `managers` needs Owner, anything else needs Manager. "Owner"
   * means `apps.author` and nobody else (auth.rs:881-882) — no role, group or
   * grant substitutes for it, and only {@link transferOwnership} moves it.
   *
   * The ladder follows the bucket rather than the endpoint because touching a
   * high-privilege array IS a high-privilege act: a Designer who can add
   * itself to `managers` has escalated, and a Manager who can strip the owner
   * out of `managers` has taken the app. That is not hypothetical — on
   * 2026-08-08 a Manager used the flat-gated version to evict an app's author
   * and install an outsider in one call.
   *
   * ## ⚠ This endpoint prices the CHANGE. `/app/acl/bulk-import` prices PRESENCE.
   *
   * Here, an incoming array that is set-equal to the stored one after
   * normalisation is not counted (app.rs:1367 → app.rs:1612: both sides are
   * bracket- and tid-normalised, sorted and deduped, so order and duplicates
   * carry no meaning). **Re-posting an unchanged `managers` array is free**,
   * which is what lets a Manager press Save on a form that renders all six
   * buckets.
   *
   * `/app/acl/bulk-import` computes its requirement from the keys the payload
   * CONTAINS (acl_admin.rs:507), so the identical payload demands Owner
   * there.
   *
   * A "save all six arrays" dialog ported between the two endpoints therefore
   * starts refusing every Manager, with no change in the data and nothing in
   * the payload to point at. When targeting the incremental surface, send
   * only the buckets you mean to change.
   *
   * ## Lock-out guard — three checks, and what it does NOT cover
   *
   * A non-author caller must, after the change: still match `managers`, not
   * match `noaccess`, and — since commit 33d202c — not have removed the app's
   * author from `managers` (acl_admin.rs:268-270). All three evaluate against
   * the caller's FULL permission set, so holding a grant through a role does
   * not dodge them. The author bypasses the guard entirely, as an
   * unrescindable recovery path.
   *
   * The third check is a **delta**, not a presence check: it fires only when
   * the author was in `managers` before and is not after. An owner may
   * legitimately not sit in `managers` at all — being the author is enough —
   * and a presence check would reject every Manager's edit to an unrelated
   * bucket. It matches by **substring**, because entries reach storage either
   * raw or bracket-wrapped depending on which path wrote them
   * (acl_admin.rs:266-267).
   *
   * This guard protects the caller and the author. It does **not** stop a
   * Designer from demoting an ordinary Manager — see {@link removeMember}.
   *
   * Refusals: `acl_array_too_large` (over 5000 entries in any array) and
   * `acl_token_unknown` (an added entry naming nobody), both thrown as
   * `BadRequestError` with the `code` preserved.
   */
  setAcl(appTid: string, acl: AppAcl): Promise<void> {
    return this.http.post("/app/acl-set", { app_tid: appTid, ...acl }).then(() => undefined);
  }

  members(): Promise<unknown> {
    return this.http.post("/app/member/list");
  }

  invite(input: { email?: string; username?: string; roles?: string[] }): Promise<unknown> {
    return this.http.post("/app/invite-user", input);
  }

  /**
   * Diff a member's role memberships to exactly `roleTids`. **Manager**
   * (`member.rs:630`).
   *
   * Manager, not Designer, because editing role membership IS editing who can
   * read and write the app: a role tid can itself sit in `apps.managers`
   * (`member.rs:625`), so handing out role assignment hands out manager
   * appointment by proxy. At the previous Designer gate a Designer could
   * assign itself a Manager-conferring role — vertical privilege escalation.
   * Roles never confer Owner, which is author-only, so Manager is the ceiling
   * this needs.
   *
   * Every target role must exist and belong to this app; an unresolvable tid
   * is refused rather than written, so a typo cannot silently grant nothing.
   */
  setMemberRoles(userTid: string, roleTids: string[]): Promise<void> {
    return this.http
      .post("/app/member/set-roles", { user_tid: userTid, role_tids: roleTids })
      .then(() => undefined);
  }

  /**
   * Strip a user from this app entirely. **Designer** (`member.rs:927`).
   *
   * ## ⚠ Managers CAN lock each other out through this endpoint
   *
   * A widely-repeated claim that "managers cannot lock each other out" does
   * not hold here. This is a **Designer**-gated call, and it clears the
   * target from all seven ACL columns — `managers` included — in one
   * statement (`member.rs:992`), plus every role they hold in the app. There
   * is **no lock-out guard in this handler**: none of the three checks that
   * protect `/app/acl-set` and `/app/acl/*` run.
   *
   * The consequence, stated plainly: **a Designer can demote any Manager who
   * is not the app's author, in a single call**, and the same call also
   * clears that person's `noaccess` veto and every role they hold. Compare
   * {@link setAcl}, where changing `managers` costs Owner.
   *
   * The only protection is the author check (`member.rs:952`), which answers
   * HTTP **409** with `code: "owner_protected"` (`member.rs:956-958`) and
   * tells you to transfer ownership first. That check compares both tid
   * spellings, because it previously compared a canonical `u-…` author
   * against whatever the client typed and let a legacy `u_…` author through
   * the surface that promised they could not be removed. It was HTTP 200
   * before commit be641c3 — so do not hard-code either status; match on
   * `code`.
   *
   * Grant Designer with this in mind. If you want the lock-out guard, edit
   * ACLs through `/app/acl/*` (`AccessClient`) instead.
   */
  removeMember(userTid: string): Promise<void> {
    return this.http.post("/app/member/remove", { user_tid: userTid }).then(() => undefined);
  }
}
