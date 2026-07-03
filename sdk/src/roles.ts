// RolesClient — per-app roles (`/app/role/*`). A role bundles permissions
// + scope bindings; users are mapped into roles (never granted ad-hoc),
// per the user-into-role discipline (dev-guide §1.3).

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

  list(): Promise<Role[]> {
    return this.http.post<Role[]>("/app/roles/list", {});
  }

  create(role: RoleInput): Promise<Role> {
    return this.http.post<Role>("/app/role/create", role);
  }

  /** Edit by tid; omitted fields stay unchanged server-side. */
  edit(tid: string, patch: Partial<RoleInput>): Promise<Role> {
    return this.http.post<Role>("/app/role/edit", { tid, ...patch });
  }

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
