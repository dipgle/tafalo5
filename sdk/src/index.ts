// @tfl5/sdk — official client for the tfl5 platform.
//
// Architecture map (what the SDK surface wraps):
//
//   TFL5                      ← config, auth mode, app scope, raw escape hatch
//    ├─ .auth                 ← /login /logout /reg /user + alt login methods
//    ├─ .apps                 ← spine root `apps` + 7-array ACL + members
//    ├─ .roles                ← per-app roles (/app/role/*)
//    ├─ .groups               ← global groups (/admin/group/*)
//    ├─ .resource(ma)         ← spine `resources` + `docs` (CRUD/list/upsert)
//    │     ├─ .hooks          ← declarative hooks (require_fields/set_fields/webhook)
//    │     └─ .getSchema()    ← fields incl. field-level encryption tiers
//    ├─ .operator(opId)       ← dispatch /op/<id>/<action> (catalog + WASM)
//    ├─ .integrations         ← per-app operator enable/config
//    ├─ .wasm                 ← tenant WASM operator lifecycle
//    ├─ .files                ← /app/file/* (+ /app/folder/*), multipart upload
//    ├─ .shares               ← per-doc grants + anonymous link claim
//    └─ .sources              ← signed inbound data channels (/app/source/*)
//
// Field-level encryption (level 0/1/2) is transparent: the server splits
// `data_indexed` (searchable plaintext) from `data_secret` (AEAD) on every
// write path — including `set_fields` hooks — so the SDK only ever handles
// plain field values.

import { AppsClient } from "./apps.js";
import { AuthClient } from "./auth.js";
import { FilesClient } from "./files.js";
import { HttpCore, type Tfl5Config } from "./http.js";
import { IntegrationsClient, OperatorClient, WasmClient } from "./operator.js";
import { ResourceClient } from "./resource.js";
import { GroupsClient, RolesClient } from "./roles.js";
import { SharesClient } from "./shares.js";
import { SourcesClient } from "./sources.js";
import type { FieldDecl, Hook } from "./types.js";

export class TFL5 {
  private readonly http: HttpCore;

  readonly auth: AuthClient;
  readonly apps: AppsClient;
  readonly roles: RolesClient;
  readonly groups: GroupsClient;
  readonly integrations: IntegrationsClient;
  readonly wasm: WasmClient;
  readonly files: FilesClient;
  readonly shares: SharesClient;
  readonly sources: SourcesClient;

  constructor(config: Tfl5Config = {}) {
    this.http = new HttpCore(config);
    this.auth = new AuthClient(this.http);
    this.apps = new AppsClient(this.http);
    this.roles = new RolesClient(this.http);
    this.groups = new GroupsClient(this.http);
    this.integrations = new IntegrationsClient(this.http);
    this.wasm = new WasmClient(this.http);
    this.files = new FilesClient(this.http);
    this.shares = new SharesClient(this.http);
    this.sources = new SourcesClient(this.http);
  }

  /** Scope subsequent calls to an app — `app_tid` is auto-injected. */
  useApp(appTid: string): this {
    this.http.appId = appTid;
    return this;
  }

  /** Currently scoped app tid, if any. */
  get appId(): string | undefined {
    return this.http.appId;
  }

  /** A client bound to one resource by its machine alias. */
  resource<T extends Record<string, unknown> = Record<string, unknown>>(
    ma: string,
  ): ResourceClient<T> {
    return new ResourceClient<T>(this.http, ma);
  }

  /** Define a NEW resource on the scoped app (`/app/resource/create`).
   *  `ma` is the machine alias used by `tfl5.resource(ma)` afterwards. */
  async createResource(input: {
    ma: string;
    name: string;
    fields?: FieldDecl[];
    hooks?: Hook[];
  }): Promise<{ tid: string; ma: string }> {
    return this.http.post("/app/resource/create", input);
  }

  /** A client bound to one operator (catalog or tenant WASM). */
  operator(opId: string): OperatorClient {
    return new OperatorClient(this.http, opId);
  }

  /** Set/replace the Bearer token (Node/CLI auth mode). */
  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }

  /** Escape hatch: POST a raw JSON body to any endpoint, get unwrapped
   *  `data`. Use when an endpoint isn't yet covered by a typed client. */
  raw<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.http.post<T>(path, body);
  }
}

export default TFL5;

export { HttpCore } from "./http.js";
export type { Tfl5Config, AuthMode } from "./http.js";
export { ResourceClient, HooksAccessor } from "./resource.js";
export type { ResourceDef, DocAcl } from "./resource.js";
export { OperatorClient, IntegrationsClient, WasmClient } from "./operator.js";
export { AppsClient } from "./apps.js";
export type { AppConfig, AppAcl } from "./apps.js";
export { RolesClient, GroupsClient } from "./roles.js";
export type { Role, RoleInput, Group } from "./roles.js";
export { FilesClient } from "./files.js";
export type { FileEntry, UploadPart } from "./files.js";
export { SharesClient } from "./shares.js";
export type { CreateShareInput, ShareGrant } from "./shares.js";
export { SourcesClient } from "./sources.js";
export type { RegisterSourceInput, SourceRecord } from "./sources.js";
export { AuthClient } from "./auth.js";
export type { LoginResult, DataExport, EraseResult } from "./auth.js";
export * from "./errors.js";
export * from "./types.js";
