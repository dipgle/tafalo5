// RolesClient — per-app roles (`/app/role/*`). A role is a named set of
// members; put its token (`[r-<tid>]`) into ACL arrays to grant it access.
// GroupsClient — `/admin/group/*`, platform-wide user groups.

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

  /** The app's roles with their members (Manager). */
  list(): Promise<Role[]> {
    return this.http.post<Role[]>("/app/roles/list", {});
  }

  /** Create a role (Manager). Use its token `[r-<tid>]` in ACL arrays. */
  create(role: RoleInput): Promise<Role> {
    return this.http.post<Role>("/app/role/create", role);
  }

  /** Edit by tid; omitted fields stay unchanged server-side. */
  edit(tid: string, patch: Partial<RoleInput>): Promise<Role> {
    return this.http.post<Role>("/app/role/edit", { tid, ...patch });
  }

  /** Delete a role (Manager). */
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

  /** All platform groups (platform operators only). */
  list(): Promise<Group[]> {
    return this.http.post<Group[]>("/admin/group/list", {});
  }

  /** Create a group (platform operators only). A taken name is refused with `validation_name_taken`. */
  create(group: Omit<Group, "tid">): Promise<Group> {
    return this.http.post<Group>("/admin/group/create", group);
  }

  /** Edit a group (platform operators only). */
  edit(tid: string, patch: Partial<Group>): Promise<Group> {
    return this.http.post<Group>("/admin/group/edit", { tid, ...patch });
  }

  /** Delete a group and remove it from every ACL (platform operators only). */
  del(tid: string): Promise<void> {
    return this.http.post("/admin/group/del", { tid }).then(() => undefined);
  }
}
