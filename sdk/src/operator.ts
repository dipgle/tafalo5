// OperatorClient — the extension plane. Two operator kinds share the
// dispatch route `/op/<op_id>/<action>`:
//   - compiled catalog operators (vietqr, viettel-sms, zalo-zns, vneid…)
//   - tenant WASM operators uploaded via /app/wasm/upload (shipped)
//
// WASM is tfl5's ONE sandboxed server-side code lane (no JS/Lua eval).
// A module runs fuel-, memory- and time-bounded, and reaches data via host
// calls that run AS the invoking user — it can never exceed the caller's
// ACL and only touches its own app. Two of the three bounds are per-tier,
// one is not: CPU (50M fuel) and linear memory (64 MiB) are defaults the
// app's license tier raises (`licenses.wasm_max_fuel` /
// `wasm_max_memory`), while the 5 s outer wall clock is a fixed
// defence-in-depth ceiling no tier lifts — budget the slow work, don't
// expect to buy more of it. It can run as a doc-lifecycle hook
// (`"type":"wasm"`) or via this dispatch route. Full reference:
// docs/api-reference.md § "WASM operators — tenant server-side code".
//
// WHAT `host_query` RETURNS — three gates, the same ones `/app/doc/list`
// applies, so a module and the HTTP list endpoint now answer identically
// for the same user:
//   1. App permission for the invoking user (Reader), resolved inside the
//      host itself rather than trusted from the caller.
//   2. The RESOURCE's own ACL (`readers`/`editors`/`noaccess`). A denied
//      caller gets an EMPTY ARRAY, not an error — the same answer the
//      HTTP path gives, so the module cannot be used to probe whether a
//      resource exists.
//   3. Row-level scope + PII level, per row: rows outside the caller's
//      cohort are dropped, rows whose binding grants only Aggregate access
//      are dropped entirely, and Masked rows are PII-masked before the
//      guest sees them.
// Gates 1 and 2 always run. Gate 3 is CONDITIONAL, on exactly the same two
// switches `/app/doc/list` obeys: the deployment sets `TFL5_ENFORCE_SCOPE`,
// AND the app declares `acls.scope.field_map`. With either one absent the
// scope filter resolves to "unconstrained" and every row survives — so a
// module tested on a deployment with enforcement off has not been tested
// against gate 3 at all. With BOTH present, a resource missing from
// `field_map` fails CLOSED: the query errors out rather than answering
// unfiltered.
// Two edges worth knowing when gate 3 IS live. Masking is guarded on the
// resource actually declaring PII fields, so a Masked binding against a
// resource that declares none returns the row unmodified — the binding is
// not what masks, the field list is. And `host_query` answers `{ok, data}`
// with no `meta`, where `/app/doc/list` reports `scope_filter_applied` and
// a `pii_aggregate_dropped` count: a guest CANNOT tell a filtered result
// from a complete one, so never write module logic that infers "no rows
// were hidden" from the response.
// Gate 2 and the Aggregate/Masked half of gate 3 are recent: before them
// a user excluded from a resource's ACL got real rows through an operator
// while the same user got an empty list over HTTP, and Aggregate/Masked
// rows arrived whole. Field-level encryption is unchanged and independent:
// `host_query` only ever reads `data_indexed`, never decrypts
// `data_secret`.
//
// AUTH: an action NOT in the operator's `public_actions()` requires the
// caller to hold Reader on the app (security review H2). Public actions
// (OAuth callbacks, customer-facing utilities like vietqr/generate) run
// un-authed. The SDK doesn't decide this — the server enforces it; a
// gated call from an anon client throws AccessDenied.

import type { HttpCore } from "./http.js";

export class OperatorClient {
  constructor(
    private readonly http: HttpCore,
    /** Operator id, e.g. "vietqr" or a tenant WASM op id. */
    readonly opId: string,
  ) {}

  /** Invoke `action` with a JSON payload. Payload keys are sent flat
   *  alongside `app_tid` (the dispatch handler flattens `extra`). */
  invoke<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.http.post<T>(`/op/${this.opId}/${action}`, payload);
  }
}

/** App-level operator administration (`/app/integrations/*`). */
export class IntegrationsClient {
  constructor(private readonly http: HttpCore) {}

  /** List operators + their enabled/configured state for the app. */
  list(): Promise<unknown> {
    return this.http.post("/app/integrations/list");
  }

  enable(opId: string): Promise<unknown> {
    return this.http.post("/app/integrations/enable", { op_id: opId });
  }

  disable(opId: string): Promise<unknown> {
    return this.http.post("/app/integrations/disable", { op_id: opId });
  }

  /** Store encrypted per-app operator config (API keys, etc.). */
  setConfig(opId: string, config: Record<string, unknown>): Promise<unknown> {
    return this.http.post("/app/integrations/config-set", { op_id: opId, config });
  }

  getConfig(opId: string): Promise<unknown> {
    return this.http.post("/app/integrations/config-get", { op_id: opId });
  }
}

/**
 * Tenant WASM operator lifecycle (`/app/wasm/*`). All three are
 * **Manager**-gated. Flow: `upload` a version (stored inactive, validated
 * for the ABI) → `activate` it (one live version per `(app, op_id)`).
 * The guest module must export `memory`, `tfl5_alloc(i32) -> i32` and
 * `tfl5_invoke(i32, i32) -> i64`, with `host_log` / `host_call` imported
 * under the module name `"tfl5"`; request and response are JSON over
 * linear memory. Byte-level guest ABI reference:
 * docs/wasm-operator-abi.md. Endpoint shapes and the per-invocation
 * payload caps: docs/api-reference.md § "WASM operators — tenant
 * server-side code". What a module can READ once it is running is the
 * three-gate contract at the top of this file.
 */
export class WasmClient {
  constructor(private readonly http: HttpCore) {}

  /** List uploaded versions + their active/public/min_license state. */
  list(): Promise<unknown> {
    return this.http.post("/app/wasm/list");
  }

  /**
   * Upload a compiled `.wasm` module version. Stored **inactive** until
   * `activate`. `version` is a caller-chosen label (alphanumeric + `. _ -`,
   * ≤48 chars), immutable per `(op_id, version)`. `public: true` opts the
   * operator into un-authed dispatch (webhooks/callbacks) with NO data
   * bridge; default is Reader-gated with a per-user-scoped data bridge.
   * Max 10 MB; the server validates the module loads + exports the ABI
   * before storing (`wasm_module_invalid` otherwise).
   */
  async upload(input: {
    op_id: string;
    version: string;
    bytecode: Uint8Array | Blob;
    public?: boolean;
    min_license?: string;
  }): Promise<unknown> {
    const form = new FormData();
    form.append("op_id", input.op_id);
    form.append("version", input.version);
    if (input.public !== undefined) form.append("public", String(input.public));
    if (input.min_license) form.append("min_license", input.min_license);
    // `as BlobPart`: see files.ts — TS 5.7+ Uint8Array/BlobPart narrowing.
    const blob =
      input.bytecode instanceof Blob ? input.bytecode : new Blob([input.bytecode as BlobPart]);
    // Field name MUST be `file` — the server's multipart handler keys on it.
    form.append("file", blob, `${input.op_id}.wasm`);
    return this.http.postForm("/app/wasm/upload", form);
  }

  /** Activate a previously-uploaded version (`version` = the upload label). */
  activate(opId: string, version: string): Promise<unknown> {
    return this.http.post("/app/wasm/activate", { op_id: opId, version });
  }
}
