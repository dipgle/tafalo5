// AppsClient — the spine root (`apps`) + membership plane.
//
// `/app/update` is dual-purpose: a body WITHOUT `tid` creates a new app;
// WITH `tid` it edits. The ACL arrays (managers/designers/editors/readers/
// deletable/noaccess) are set via `/app/acl-set`. Members are users mapped
// into per-app roles or granted directly.

import type { HttpCore } from "./http.js";

export type AppPermLevelName = "owner" | "manager" | "designer" | "editor" | "reader";

export interface AppConfig {
  tid: string;
  name?: string;
  description?: string;
  icon?: string;
  author?: string;
  /** The caller's level on this app (`/app/get`). */
  my_level?: AppPermLevelName;
  /** Path served for every unknown URL (single-page apps), or null. */
  single_page?: string | null;
  /** Path served on 404, or null. */
  error_page?: string | null;
  domains_quota?: { max: number; used: number };
  managers?: string[];
  designers?: string[];
  editors?: string[];
  readers?: string[];
  deletable?: string[];
  noaccess?: string[];
  [k: string]: unknown;
}

export interface AppMember {
  user_tid: string;
  username: string | null;
  display_name: string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: number;
  /** The user id is in an ACL but the account no longer exists. */
  stale?: boolean;
  [k: string]: unknown;
}

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

  /** One app's settings, including its ACL arrays and the caller's `my_level`. */
  get(appTid: string): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/get", { tid: appTid });
  }

  /** Create a new app (omit `tid`). Only name/description/icon are honored
   *  in `data` — ACL fields here are REJECTED (use `setAcl`). */
  create(data: { name?: string; description?: string; icon?: string }): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/update", { data });
  }

  /**
   * Edit an app (Manager). `single_page` / `error_page` name a path served
   * for unknown URLs / on 404; pass `""` to clear. ACL changes go through
   * `setAcl`.
   */
  update(
    tid: string,
    data: { name?: string; description?: string; icon?: string; single_page?: string; error_page?: string },
  ): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/update", { tid, data });
  }

  /**
   * Delete an app (Owner). The first call soft-deletes it; calling again on
   * a soft-deleted app destroys it and all its data for good.
   */
  del(appTid: string): Promise<void> {
    return this.http.post("/app/del", { tid: appTid }).then(() => undefined);
  }

  /**
   * Hand the app to another user (Owner only). By default the previous owner
   * loses access; pass `keepOldAsManager: true` to keep them as a Manager.
   */
  transferOwnership(
    appTid: string,
    newOwnerTid: string,
    opts: { keepOldAsManager?: boolean; reason?: string } = {},
  ): Promise<void> {
    return this.http
      .post("/app/transfer-ownership", {
        app_tid: appTid,
        new_owner_tid: newOwnerTid,
        ...(opts.keepOldAsManager ? { keep_old_as_manager: true } : {}),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      })
      .then(() => undefined);
  }

  // ---- ACL + members -------------------------------------------------

  /**
   * Replace some of the app's ACL arrays (Manager). Each array you pass
   * replaces the stored one; arrays you omit are kept. Role ids may be sent
   * raw (`r-…`); the server stores them as `[r-…]`.
   */
  setAcl(appTid: string, acl: AppAcl): Promise<void> {
    return this.http.post("/app/acl-set", { app_tid: appTid, ...acl }).then(() => undefined);
  }

  /**
   * One page of the app's members (Designer). Filter with `search` (username)
   * or `roleFilter` (a role tid, or `"__direct"` for members granted
   * directly). Pass the returned `nextOffset` as `offset` for the next page.
   */
  async members(
    opts: { search?: string; roleFilter?: string; limit?: number; offset?: number } = {},
  ): Promise<{ members: AppMember[]; total: number; nextOffset: number | null }> {
    const env = await this.http.postEnvelope<{ data: AppMember[]; total: number; next_offset: number | null }>(
      "/app/member/list",
      {
        ...(opts.search !== undefined ? { search: opts.search } : {}),
        ...(opts.roleFilter !== undefined ? { role_filter: opts.roleFilter } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      },
    );
    return { members: env.data ?? [], total: env.total, nextOffset: env.next_offset ?? null };
  }

  /**
   * Invite someone by email, optionally with roles. A new address gets a
   * sign-in link (`status: "sent"`); an address that already has an account
   * answers `status: "user_already_exists"` with its `user_tid` — add that
   * user with `setMemberRoles()`.
   */
  invite(input: { email: string; roleTids?: string[]; redirectTo?: string; note?: string }): Promise<{
    tid?: string;
    status: "sent" | "user_already_exists" | "would_send" | (string & {});
    user_tid?: string;
  }> {
    return this.http.post("/app/invite-user", {
      email: input.email,
      ...(input.roleTids !== undefined ? { role_tids: input.roleTids } : {}),
      ...(input.redirectTo !== undefined ? { redirect_to: input.redirectTo } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  }

  /** Set a member's roles to exactly `roleTids` (Manager). */
  setMemberRoles(userTid: string, roleTids: string[]): Promise<void> {
    return this.http
      .post("/app/member/set-roles", { user_tid: userTid, role_tids: roleTids })
      .then(() => undefined);
  }

  /** Remove a user from every role and direct grant in the app (Designer). */
  removeMember(userTid: string): Promise<void> {
    return this.http.post("/app/member/remove", { user_tid: userTid }).then(() => undefined);
  }

  /**
   * Find users by username to add to the app (Designer). Case-insensitive
   * substring match on `username` only; banned accounts are excluded.
   * `query` must be at least 2 characters (else code `query_too_short`);
   * `limit` defaults to 10, max 25.
   */
  searchMembers(
    query: string,
    opts: { limit?: number } = {},
  ): Promise<Array<{ user_tid: string; username: string; display_name: string | null }>> {
    return this.http.post("/app/member/search", { query, ...opts });
  }
}
