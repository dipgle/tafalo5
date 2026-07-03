// AppsClient — the spine root (`apps`) + membership plane.
//
// `/app/update` is dual-purpose: a body WITHOUT `tid` creates a new app;
// WITH `tid` it edits. The 7-array ACL (managers/editors/readers/...) is
// set via `/app/acl-set`. Members are users mapped into per-app roles.

import type { HttpCore } from "./http.js";

export interface AppConfig {
  tid: string;
  name?: string;
  description?: string;
  icon?: string;
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

  /** Fetch one app's config (does NOT echo ACL arrays — use the
   *  app's ACL endpoint separately). Keyed by `tid`. */
  get(appTid: string): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/get", { tid: appTid });
  }

  /** Create a new app (omit `tid`). Only name/description/icon are honored
   *  in `data` — ACL fields here are REJECTED (use `setAcl`). */
  create(data: { name?: string; description?: string; icon?: string }): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/update", { data });
  }

  /** Edit an existing app. `tid` is a TOP-LEVEL field; `data` carries
   *  name/description/icon only (ACL changes go through `setAcl`). */
  update(
    tid: string,
    data: { name?: string; description?: string; icon?: string },
  ): Promise<AppConfig> {
    return this.http.post<AppConfig>("/app/update", { tid, data });
  }

  del(appTid: string): Promise<void> {
    return this.http.post("/app/del", { tid: appTid }).then(() => undefined);
  }

  transferOwnership(appTid: string, toUserTid: string): Promise<void> {
    return this.http
      .post("/app/transfer-ownership", { app_tid: appTid, to: toUserTid })
      .then(() => undefined);
  }

  // ---- ACL + members -------------------------------------------------

  /** Replace the app's 7-array ACL. */
  setAcl(appTid: string, acl: AppAcl): Promise<void> {
    return this.http.post("/app/acl-set", { app_tid: appTid, ...acl }).then(() => undefined);
  }

  members(): Promise<unknown> {
    return this.http.post("/app/member/list");
  }

  invite(input: { email?: string; username?: string; roles?: string[] }): Promise<unknown> {
    return this.http.post("/app/invite-user", input);
  }

  /** Diff a member's role memberships to exactly `roleTids`. */
  setMemberRoles(userTid: string, roleTids: string[]): Promise<void> {
    return this.http
      .post("/app/member/set-roles", { user_tid: userTid, role_tids: roleTids })
      .then(() => undefined);
  }

  removeMember(userTid: string): Promise<void> {
    return this.http.post("/app/member/remove", { user_tid: userTid }).then(() => undefined);
  }
}
