// RolesClient — per-app roles (`/app/role/*`). A role bundles permissions
// + scope bindings; users are mapped into roles (never granted ad-hoc),
// per the user-into-role discipline (dev-guide §1.3).
//
// ## All four endpoints are Manager-gated
//
//   POST /app/roles/list   — Manager (roles.rs:62)
//   POST /app/role/create  — Manager (roles.rs:118)
//   POST /app/role/edit    — Manager (roles.rs:223)
//   POST /app/role/del     — Manager (roles.rs:339)
//
// Manager, not Designer or Editor, and the reason is escalation rather than
// data sensitivity: a role tid can itself sit in `apps.managers`
// (`member.rs:625`), conferring Manager on everyone in that role. So handing
// out role editing hands out manager appointment by proxy — a Designer able
// to edit roles could add itself to a Manager-conferring role and climb the
// ladder. Roles never confer Owner (that is `apps.author` alone), so Manager
// is the correct bar rather than Owner.
//
// The same reasoning puts `/app/member/set-roles` at Manager
// (`member.rs:630`) — see `AppsClient.setMemberRoles`.
//
// This applies to `list` as well as the writers: role membership IS access,
// so reading who holds which role is a Manager-level read. A screen that
// fetches this for every viewer will render an error for anyone below
// Manager — gate the call on `my_level` from `/app/get` first. A user who
// only needs their OWN roles should call `AccessClient.roleListForUser`
// instead, which allows self-introspection at Reader.

import type { HttpCore } from "./http.js";

export interface Role {
  tid: string;
  name: string;
  description?: string;
  members?: string[];
  [k: string]: unknown;
}

export interface RoleInput {
  name: string;
  description?: string;
  /** user_tids / group tids granted this role. */
  members?: string[];
}

export class RolesClient {
  constructor(private readonly http: HttpCore) {}

  /** Every role in the app. **Manager** — role membership is access. */
  list(): Promise<Role[]> {
    return this.http.post<Role[]>("/app/roles/list", {});
  }

  /** Create a role. **Manager** (see this module's header for why). */
  create(role: RoleInput): Promise<Role> {
    return this.http.post<Role>("/app/role/create", role);
  }

  /**
   * Edit by tid; omitted fields stay unchanged server-side. **Manager**.
   *
   * A supplied `members` REPLACES the full list rather than merging into it
   * (`roles.rs:285`) — this is the intended revocation path, since changing
   * one role's membership takes effect everywhere that role is referenced.
   * Capped at 5000 members (`roles.rs:246`).
   */
  edit(tid: string, patch: Partial<RoleInput>): Promise<Role> {
    return this.http.post<Role>("/app/role/edit", { tid, ...patch });
  }

  /**
   * Delete a role. **Manager**. Throws `NotFoundError` when no such role
   * exists in this app.
   *
   * One transaction: drop the role row, then `array_remove` the role's
   * bracketed token from all six ACL arrays on `apps` and all five on `files`
   * (`roles.rs:355-398`). The app config cache is invalidated AFTER the commit
   * (`roles.rs:404`), not inside it. The token is
   * stripped so a dead role tid stops looking like a real grant if somebody
   * later re-creates a role with the same name under a different tid.
   *
   * ⚠ The cleanup covers `apps` and `files` only — it does **not** reach
   * per-doc or per-resource ACLs. A deleted role's token can survive in
   * those, where it matches nothing but still reads as a grant to anyone
   * inspecting the row.
   */
  del(tid: string): Promise<void> {
    return this.http.post("/app/role/del", { tid }).then(() => undefined);
  }
}

// GroupsClient — global (cross-app) groups, admin-scoped (`/admin/group/*`).
export interface Group {
  tid?: string;
  name?: string;
  members?: string[];
  [k: string]: unknown;
}

export class GroupsClient {
  constructor(private readonly http: HttpCore) {}

  list(): Promise<Group[]> {
    return this.http.post<Group[]>("/admin/group/list", {});
  }

  create(group: Omit<Group, "tid">): Promise<Group> {
    return this.http.post<Group>("/admin/group/create", group);
  }

  edit(tid: string, patch: Partial<Group>): Promise<Group> {
    return this.http.post<Group>("/admin/group/edit", { tid, ...patch });
  }

  del(tid: string): Promise<void> {
    return this.http.post("/admin/group/del", { tid }).then(() => undefined);
  }
}
