// ScopeClient — row-level scope settings (`/app/scope/*`): which column of
// each resource carries a scope attribute (the field map), and which values
// each user may see (bindings). The same endpoints are also reachable as
// `tfl5.access.scopeGet()` / `scopeSet()`.

import type { HttpCore } from "./http.js";
import type { ScopeBinding, ScopeGetResult, ScopeFieldMap, ScopeSetResult } from "./access.js";

export class ScopeClient {
  constructor(private readonly http: HttpCore) {}

  /** The app's field map and the caller's own bindings (never other users'). */
  get(): Promise<ScopeGetResult> {
    return this.http.post<ScopeGetResult>("/app/scope/get", {});
  }

  /** Replace the whole field map (Designer). `{}` clears it and turns scope off. */
  setFieldMap(fieldMap: ScopeFieldMap): Promise<ScopeSetResult> {
    return this.http.post<ScopeSetResult>("/app/scope/set", { field_map: fieldMap });
  }

  /** Replace every user's bindings at once (Designer). */
  setBindings(bindings: Record<string, ScopeBinding[]>): Promise<ScopeSetResult> {
    return this.http.post<ScopeSetResult>("/app/scope/set", { bindings });
  }

  /** Change some users' bindings: an array sets them, `null` clears them (Designer). */
  patchBindings(patch: Record<string, ScopeBinding[] | null>): Promise<ScopeSetResult> {
    return this.http.post<ScopeSetResult>("/app/scope/set", { bindings_patch: patch });
  }
}
