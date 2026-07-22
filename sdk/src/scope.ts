// ScopeClient — row-level scope config (`/app/scope/*`). See docs/scope.md.
//
// Scope is the 4th authorization layer: it fences ROWS by a data field (own /
// company / class / …) so a user only sees their lane, complementing the ACL
// layers. Designer-level. Enforcement is env-gated on the cell
// (TFL5_ENFORCE_SCOPE) AND per-app opt-in (a non-empty field_map), so a returned
// config does not by itself mean rows are being filtered — check
// `meta.scope_filter_applied` on a `/app/doc/list` response to confirm.

import type { HttpCore } from "./http.js";

/** A scope tier code. G = global (all rows), N = none (no rows),
 *  W/S/C = a widest→narrowest containment hierarchy, M = multi-value at the
 *  C tier, O = own records. The letters carry NO built-in domain meaning —
 *  a CRM reads S as "company", a school reads it as "school". See docs/scope.md. */
export type ScopeCode = "G" | "W" | "S" | "C" | "M" | "O" | "N";

/** One grant in a user's bindings. `params` carries the allowed value(s) keyed
 *  by the scope code (generic form, e.g. `{ "S": "acme" }`) or the legacy alias
 *  (e.g. `{ "school_code": "acme" }`). See docs/scope.md §3. */
export interface ScopeBinding {
  scope: ScopeCode;
  params?: Record<string, string | string[]>;
  /** Optional label for auditing/debugging; not enforced. */
  role_code?: string;
  [k: string]: unknown;
}

/** Per-resource field_map: `{ <resource_ma>: { <scope-code-or-alias>: <column> } }`.
 *  Setting a resource's entry is what opts that resource into scope. */
export type ScopeFieldMap = Record<string, Record<string, string>>;

/** Result of {@link ScopeClient.get}. `my_bindings` is only the CALLER's own
 *  bindings — you never see another user's grants. */
export interface ScopeConfig {
  field_map: ScopeFieldMap;
  my_bindings: ScopeBinding[];
  [k: string]: unknown;
}

export class ScopeClient {
  constructor(private readonly http: HttpCore) {}

  /** Read the app's `field_map` + the CALLER's own bindings (never others'). */
  get(): Promise<ScopeConfig> {
    return this.http.post<ScopeConfig>("/app/scope/get", {});
  }

  /** Replace the whole `field_map` (which column implements each tier, per
   *  resource). Omit to keep the current one. */
  async setFieldMap(fieldMap: ScopeFieldMap): Promise<void> {
    await this.http.post("/app/scope/set", { field_map: fieldMap });
  }

  /** Replace ALL users' bindings at once. */
  async setBindings(bindings: Record<string, ScopeBinding[]>): Promise<void> {
    await this.http.post("/app/scope/set", { bindings });
  }

  /** Patch specific users' bindings without touching the rest:
   *  an array SETS that user's bindings, `null` CLEARS them. */
  async patchBindings(patch: Record<string, ScopeBinding[] | null>): Promise<void> {
    await this.http.post("/app/scope/set", { bindings_patch: patch });
  }
}
