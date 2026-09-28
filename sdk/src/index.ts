// @tfl5/sdk — official client for the tfl5 platform.
//
// Architecture map (what the SDK surface wraps):
//
//   TFL5                      ← config, auth mode, app scope, raw escape hatch
//    ├─ .auth                 ← /login /logout /reg /user + alt login methods
//    ├─ .apps                 ← spine root `apps` + ACL arrays + members
//    ├─ .roles                ← per-app roles (/app/role/*)
//    ├─ .groups               ← platform-wide groups (/admin/group/*, platform operators)
//    ├─ .resource(ma)         ← spine `resources` + `docs` (CRUD/list/upsert)
//    │     ├─ .hooks          ← declarative hooks (require_fields/set_fields/webhook/wasm)
//    │     └─ .getSchema()    ← fields incl. field-level encryption tiers
//    ├─ .operator(opId)       ← dispatch /op/<id>/<action> (catalog + WASM)
//    ├─ .integrations         ← per-app operator enable/config
//    ├─ .wasm                 ← tenant WASM operator lifecycle
//    ├─ .files                ← /app/file/* (+ /app/folder/*), multipart upload
//    ├─ .shares               ← per-doc grants + anonymous link claim
//    ├─ .sources              ← signed inbound data channels (/app/source/*)
//    ├─ .access               ← scope/config + granular ACL (list/set/revoke/bulk)
//    ├─ .bundle / .stages     ← FE bundle lifecycle + Draft/Live release stages
//    ├─ .email                ← send / inbox / DKIM+DNS (/app/email/*)
//    ├─ .account              ← current-user profile / password / 2FA / emails
//    ├─ .domain               ← custom domains + cross-tenant delegation
//    ├─ .license              ← plan catalog / usage / redeem / self-upgrade
//    ├─ .f3                   ← secure per-doc encrypted attachments
//    ├─ .audit                ← app control-plane audit log (/app/audit/list)
//    ├─ .chat                 ← chat history, live socket, room settings
//    ├─ .publicForm           ← anonymous forms + their admin (alias .publicForms)
//    ├─ .durable              ← durable operator instances (/durable/*, /ws/durable/subscribe)
//    ├─ .resources            ← resource definitions: list/create/constraints/import preview
//    ├─ .site                 ← site engine: draft → publish → rollback (/app/site/*)
//    ├─ .identity             ← avatar/display name shared by grant (/user/identity/*)
//    ├─ .billing              ← catalog, checkout, credits, invoices, entitlement tokens
//    ├─ .platform             ← public sign-in settings + server version (GET)
//    └─ .scope                ← row-level scope settings (also via .access)
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
import { AccessClient } from "./access.js";
import { BundleClient, StagesClient } from "./deploy.js";
import { EmailClient } from "./email.js";
import { AccountClient } from "./account.js";
import { DomainClient } from "./domain.js";
import { LicenseClient } from "./license.js";
import { F3Client } from "./f3.js";
import { AuditClient } from "./audit.js";
import { ChatClient } from "./chat.js";
import { PublicFormClient } from "./publicform.js";
import { ScopeClient } from "./scope.js";
import { DurableClient } from "./durable.js";
import { ResourcesClient } from "./resources.js";
import { SiteClient } from "./site.js";
import { IdentityClient } from "./identity.js";
import { BillingClient } from "./billing.js";
import { PlatformClient } from "./platform.js";
import type { NewResource } from "./resources.js";

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
  readonly access: AccessClient;
  readonly bundle: BundleClient;
  readonly stages: StagesClient;
  readonly email: EmailClient;
  readonly account: AccountClient;
  readonly domain: DomainClient;
  readonly license: LicenseClient;
  readonly f3: F3Client;
  readonly audit: AuditClient;
  readonly chat: ChatClient;
  readonly publicForm: PublicFormClient;
  readonly durable: DurableClient;
  readonly resources: ResourcesClient;
  readonly site: SiteClient;
  readonly identity: IdentityClient;
  readonly billing: BillingClient;
  readonly platform: PlatformClient;
  /** Row-level scope settings (`/app/scope/*`); same endpoints as `access.scopeGet/scopeSet`. */
  readonly scope: ScopeClient;
  /** Alias of `bundle` (name used by SDK 0.1.0). */
  readonly bundles: BundleClient;
  /** Alias of `domain` (name used by SDK 0.1.0). */
  readonly domains: DomainClient;
  /** Alias of `publicForm` (name used by SDK 0.1.0). */
  readonly publicForms: PublicFormClient;

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
    this.access = new AccessClient(this.http);
    this.bundle = new BundleClient(this.http);
    this.stages = new StagesClient(this.http);
    this.email = new EmailClient(this.http);
    this.account = new AccountClient(this.http);
    this.domain = new DomainClient(this.http);
    this.license = new LicenseClient(this.http);
    this.f3 = new F3Client(this.http);
    this.audit = new AuditClient(this.http);
    this.chat = new ChatClient(this.http);
    this.publicForm = new PublicFormClient(this.http);
    this.durable = new DurableClient(this.http);
    this.resources = new ResourcesClient(this.http);
    this.site = new SiteClient(this.http);
    this.identity = new IdentityClient(this.http);
    this.billing = new BillingClient(this.http);
    this.platform = new PlatformClient(this.http);
    this.scope = new ScopeClient(this.http);
    this.bundles = this.bundle;
    this.domains = this.domain;
    this.publicForms = this.publicForm;
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

  /** Same as `tfl5.resources.create()` (kept for existing callers). */
  async createResource(input: NewResource): Promise<{ tid: string; ma: string }> {
    return this.resources.create(input);
  }

  /** A client bound to one operator (catalog or tenant WASM). */
  operator(opId: string): OperatorClient {
    return new OperatorClient(this.http, opId);
  }

  /** Set/replace the Bearer token (service tokens, `auth: "bearer"`). */
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
export type { ResourceDef, DocAcl, ImportResult } from "./resource.js";
export { ResourcesClient } from "./resources.js";
export type { ResourceSummary, ResourceConstraint, InferredSchema, NewResource } from "./resources.js";
export { SiteClient } from "./site.js";
export type { SiteEntry, SiteSnapshot, SiteFileVersion, SitePutInput, SiteImportResult } from "./site.js";
export { IdentityClient } from "./identity.js";
export type {
  IdentityFacet,
  IdentityAudience,
  IdentityGrant,
  ResolvedIdentity,
  IdentityAccessEntry,
} from "./identity.js";
export { BillingClient, CreditsClient, InvoicesClient } from "./billing.js";
export type {
  BillingCatalog,
  CatalogPlan,
  CheckoutOrder,
  AccountStatus,
  PlanChangeQuote,
  Invoice,
  Money,
} from "./billing.js";
export { PlatformClient } from "./platform.js";
export type { PlatformInfo, PlatformVersion } from "./platform.js";
export { OperatorClient, IntegrationsClient, WasmClient } from "./operator.js";
export { AppsClient } from "./apps.js";
export type { AppConfig, AppAcl } from "./apps.js";
export { RolesClient, GroupsClient } from "./roles.js";
export type { Role, RoleInput, Group } from "./roles.js";
export { FilesClient } from "./files.js";
export type {
  FileEntry,
  FileStage,
  UploadPart,
  UploadOptions,
  UploadResult,
  FileWriteWarning,
  FileRenameResult,
  FileDeleteResult,
  WrittenFile,
  SaveInput,
  FileContent,
  FileAclInput,
  FileAcl,
  TrashEntry,
} from "./files.js";
export { SharesClient } from "./shares.js";
export type { CreateShareInput, ShareGrant } from "./shares.js";
export { SourcesClient } from "./sources.js";
export type { RegisterSourceInput, SourceRecord } from "./sources.js";
export { AuthClient } from "./auth.js";
export type {
  LoginResult,
  CurrentUser,
  DataExport,
  EraseResult,
  QrStartResult,
  QrPollResult,
  TelegramWidgetPayload,
  TelegramStatus,
  VneidStartResult,
} from "./auth.js";
export { AccessClient } from "./access.js";
export { BundleClient, StagesClient } from "./deploy.js";
export type {
  BundleVersion,
  BundleUploadResult,
  BundleDeleteResult,
  ReleaseResult,
  ReleaseStatus,
} from "./deploy.js";
export { EmailClient } from "./email.js";
export { AccountClient } from "./account.js";
export { DomainClient } from "./domain.js";
export { LicenseClient } from "./license.js";
export { F3Client } from "./f3.js";
export type { F3DownloadResult } from "./f3.js";
export { AuditClient } from "./audit.js";
export type { AuditListInput, AuditRow, AuditListResult, AuditTargetKind } from "./audit.js";
export { ChatClient, ChatSocket, chatResumeCursor } from "./chat.js";
export type {
  ChatHistoryInput,
  ChatHistoryResult,
  ChatMessage,
  ChatConnectOptions,
  ChatServerEvent,
  ChatWsMsgEvent,
  ChatWsDeletedEvent,
  ChatWsWelcomeEvent,
  ChatWsPongEvent,
  ChatWsErrorEvent,
  ChatWebSocketLike,
  ChatRoomMinLevel,
  ChatRoomScopeAttrs,
  ChatRoomConfigInput,
  ChatRoomConfigResult,
  ChatSetRoomConfigInput,
  ChatSetRoomConfigResult,
  ChatRemoveRoomConfigResult,
} from "./chat.js";
export { PublicFormClient } from "./publicform.js";
export type {
  PublicFormSubmitInput,
  PublicFormSubmitResult,
  PublicFormFieldDecl,
  PublicFormSchema,
  PublicFormConfig,
  PublicFormConfigMap,
  PublicFormSubmission,
  PublicFormListResult,
} from "./publicform.js";
export { ScopeClient } from "./scope.js";
export { DurableClient, DurableSubscription, SUBSCRIBE_KEYS_MAX, DURABLE_RETRYABLE_CODES } from "./durable.js";
export type {
  DurableSendInput,
  DurableSendResult,
  DurableStats,
  DurableMailGrant,
  DurableSubscribeInput,
  DurableSubscribeOptions,
  DurableSubscriptionError,
  DurableSubscriptionStatus,
  ProjectionRow,
  ResourceKeyPair,
  WebSocketLike,
} from "./durable.js";
export * from "./errors.js";
export * from "./types.js";
