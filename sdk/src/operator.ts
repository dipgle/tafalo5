// OperatorClient — the extension plane. Two operator kinds share the
// dispatch route `/op/<op_id>/<action>`:
//   - compiled catalog operators (vietqr, viettel-sms, zalo-zns, vneid…)
//   - tenant WASM operators uploaded via /app/wasm/upload (shipped)
//
// WASM is tfl5's ONE sandboxed server-side code lane (no JS/Lua eval).
// A module runs fuel/memory/time-bounded (defaults 50M fuel / 64 MiB /
// 5 s, per-tier tunable) and reaches data via host calls that run AS the
// invoking user — it can never exceed the caller's ACL and only touches
// its own app. It can run as a doc-lifecycle hook (`"type":"wasm"`) or via
// this dispatch route. Full reference: docs/api-reference.md
// §Operators → "WASM operators".
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
 * The guest module must export `memory`, `tfl5_alloc`, `tfl5_invoke`; see
 * the internal `wasm-operator-abi.md`. Sandbox limits + ACL behaviour:
 * docs/api-reference.md §Operators → "WASM operators".
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
