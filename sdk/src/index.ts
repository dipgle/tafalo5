// @tfl5/sdk — official client for the tfl5 platform.
//
// Architecture map (what the SDK surface wraps):
//
//   TFL5                      ← config, auth mode, app scope, raw escape hatch
//    ├─ .auth                 ← /login /logout /reg /user + alt login methods
//    ├─ .apps                 ← spine root `apps` + 6-array ACL + members
//    ├─ .roles                ← per-app roles (/app/role/*)
//    ├─ .groups               ← global groups (/admin/group/*)
//    ├─ .access               ← incremental ACL + membership admin
//    │                          (/app/acl/*, /app/member/*)
//    ├─ .audit                ← per-tenant audit feed (/app/audit/list)
//    ├─ .resource(ma)         ← spine `resources` + `docs` (CRUD/list/upsert)
//    │     ├─ .hooks          ← declarative hooks (require_fields/set_fields/webhook)
//    │     ├─ .setResourceAcl ← per-resource-type ACL gate (acl-model.md)
//    │     └─ .getSchema()    ← fields incl. field-level encryption tiers
//    ├─ .scope                ← row-level scope config (/app/scope/*, see scope.md)
//    ├─ .operator(opId)       ← dispatch /op/<id>/<action> (catalog + WASM)
//    ├─ .integrations         ← per-app operator enable/config
//    ├─ .wasm                 ← tenant WASM operator lifecycle
//    ├─ .files                ← /app/file/* (+ /app/folder/*), multipart upload
//    ├─ .shares               ← per-doc grants + anonymous link claim
//    ├─ .sources              ← signed inbound data channels (/app/source/*)
//    ├─ .site                 ← content-addressed site engine (/app/site/*):
//    │                          author → publish a snapshot → roll back
//    ├─ .bundles / .domains   ← legacy bundle tier + custom domains + delegation
//    ├─ .stages               ← oldest publish tier: test→release promotion
//    │                          (/app/release*, /app/test/*). A `site`
//    │                          snapshot shadows `bundles`, which shadows this.
//    ├─ .publicForms          ← anonymous form submit + Designer/Manager admin
//    ├─ .f3                   ← encrypted file vault attached to records
//    ├─ .email                ← per-app outbound mail + DKIM + inbox
//    ├─ .chat                 ← per-app chat history + live socket
//    ├─ .billing              ← public catalog, subscription, credits, invoices
//    ├─ .account              ← the signed-in user's own profile / emails / 2FA
//    └─ .durable              ← stateful actors (OFF unless the operator enables it)
//
// Field-level encryption (level 0/1/2) is transparent: the server splits
// `data_indexed` (searchable plaintext) from `data_secret` (AEAD) on every
// write path — including `set_fields` hooks — so the SDK only ever handles
// plain field values.

import { AccessClient } from "./access.js";
import { AccountClient } from "./account.js";
import { AppsClient } from "./apps.js";
import { AuditClient } from "./audit.js";
import { AuthClient } from "./auth.js";
import { BillingClient } from "./billing.js";
import { ChatClient } from "./chat.js";
import { BundleClient, DomainClient, StagesClient } from "./deploy.js";
import { DurableClient } from "./durable.js";
import { EmailClient } from "./email.js";
import { F3Client } from "./f3.js";
import { FilesClient } from "./files.js";
import { HttpCore, type Tfl5Config } from "./http.js";
import { IntegrationsClient, OperatorClient, WasmClient } from "./operator.js";
import { PublicFormClient } from "./publicform.js";
import { ResourceClient } from "./resource.js";
import { GroupsClient, RolesClient } from "./roles.js";
import { ScopeClient } from "./scope.js";
import { SharesClient } from "./shares.js";
import { SiteClient } from "./site.js";
import { SourcesClient } from "./sources.js";
import type { FieldDecl, Hook } from "./types.js";

export class TFL5 {
  private readonly http: HttpCore;

  readonly auth: AuthClient;
  readonly apps: AppsClient;
  readonly roles: RolesClient;
  readonly groups: GroupsClient;
  /** Incremental ACL + membership admin (`/app/acl/*`, `/app/member/*`).
   *  Bucket writes are priced by the ladder — touching `managers` costs
   *  Owner. `/app/member/set-direct-grants` has NO Manager floor. */
  readonly access: AccessClient;
  /** Per-tenant audit feed (`/app/audit/list`). **Manager.** Carries
   *  child-resource events and `app.access.denied` permission refusals.
   *  Note it does NOT carry `/app/member/*` or role CRUD — see
   *  acl-model.md's coverage table before relying on it. */
  readonly audit: AuditClient;
  readonly integrations: IntegrationsClient;
  readonly wasm: WasmClient;
  readonly files: FilesClient;
  readonly shares: SharesClient;
  readonly sources: SourcesClient;
  /** Row-level scope config (`/app/scope/*`). See docs/scope.md. */
  readonly scope: ScopeClient;
  /** Content-addressed site engine (`/app/site/*`) — the current publish path. */
  readonly site: SiteClient;
  /** Legacy bundle tier (`/app/bundle/*`). `site` supersedes it. */
  readonly bundles: BundleClient;
  /** Custom domains + subdomain delegation (`/app/domain/*`). */
  readonly domains: DomainClient;
  /** Legacy test→release promotion pipeline + test-stage quota
   *  (`/app/release*`, `/app/test/*`). The OLDEST publish tier: a `site`
   *  snapshot shadows `bundles`, which shadows this. Promotion is
   *  asynchronous — `release()` queues a job, `releaseStatus()` reports it. */
  readonly stages: StagesClient;
  /** Anonymous public-form submissions plus the Designer/Manager admin
   *  control plane (`/app/public-form/submit`, `/admin/public-form/*`). */
  readonly publicForms: PublicFormClient;
  /** Encrypted per-record file vault (`/app/f3/*`). */
  readonly f3: F3Client;
  /** Per-app outbound mail, DKIM and inbox (`/app/email/*`). */
  readonly email: EmailClient;
  /** Per-app chat history + live socket. */
  readonly chat: ChatClient;
  /** Catalog, subscription, credits and invoices. */
  readonly billing: BillingClient;
  /** The signed-in user's own account (`/user/*`, `/user/2fa/*`). */
  readonly account: AccountClient;
  /** Durable stateful actors. Ships DISABLED — the operator must set
   *  `TFL5_DURABLE_ENABLED` before any of these calls will work. */
  readonly durable: DurableClient;

  constructor(config: Tfl5Config = {}) {
    this.http = new HttpCore(config);
    this.auth = new AuthClient(this.http);
    this.apps = new AppsClient(this.http);
    this.roles = new RolesClient(this.http);
    this.groups = new GroupsClient(this.http);
    this.access = new AccessClient(this.http);
    this.audit = new AuditClient(this.http);
    this.integrations = new IntegrationsClient(this.http);
    this.wasm = new WasmClient(this.http);
    this.files = new FilesClient(this.http);
    this.shares = new SharesClient(this.http);
    this.sources = new SourcesClient(this.http);
    this.scope = new ScopeClient(this.http);
    this.site = new SiteClient(this.http);
    this.bundles = new BundleClient(this.http);
    this.domains = new DomainClient(this.http);
    this.stages = new StagesClient(this.http);
    this.publicForms = new PublicFormClient(this.http);
    this.f3 = new F3Client(this.http);
    this.email = new EmailClient(this.http);
    this.chat = new ChatClient(this.http);
    this.billing = new BillingClient(this.http);
    this.account = new AccountClient(this.http);
    this.durable = new DurableClient(this.http);
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
export type {
  ResourceDef, DocAcl, ResourceAcl, ResourceConstraints,
  ResourceConstraintEntry, ResourceAclBreakdown, ResourceOrphan,
} from "./resource.js";
export { ScopeClient } from "./scope.js";
export type { ScopeCode, ScopeBinding, ScopeFieldMap, ScopeConfig } from "./scope.js";
export { OperatorClient, IntegrationsClient, WasmClient } from "./operator.js";
export { AppsClient } from "./apps.js";
export type { AppConfig, AppAcl } from "./apps.js";
export { RolesClient, GroupsClient } from "./roles.js";
export type { Role, RoleInput, Group } from "./roles.js";
export { AccessClient } from "./access.js";
export type {
  AclBucket, AppAclArrays, AclBulkGrants, DirectGrantArray,
  MemberRole, MemberDetail, MemberSearchHit, SetDirectGrantsResult, RoleEntry,
} from "./access.js";
export { AuditClient } from "./audit.js";
export type {
  AuditTargetKind, AuditListInput, AuditRow, AuditListResult,
} from "./audit.js";
export { FilesClient } from "./files.js";
export type {
  FileEntry, UploadedFile, UploadPart, FileWriteWarning,
  FileWriteEnvelope, FileDeleteResult, FileRenameResult, FileUploadResult,
} from "./files.js";
export { SharesClient } from "./shares.js";
export type { CreateShareInput, ShareGrant } from "./shares.js";
export { SourcesClient } from "./sources.js";
export type { RegisterSourceInput, SourceRecord } from "./sources.js";
export { AuthClient } from "./auth.js";
export type { LoginResult, DataExport, EraseResult } from "./auth.js";
export { SiteClient } from "./site.js";
export type {
  SiteEntryKind, SiteEntry, PutEntryInput, PutEntryResult, BlobLookup,
  SiteSnapshot, BackfillReason, BackfillResult,
  // A site snapshot's file version — distinct from anything in files.ts.
  FileVersion as SiteFileVersion,
} from "./site.js";
export { BundleClient, DomainClient, StagesClient } from "./deploy.js";
export type {
  BundleVersion, BundleUploadResult, BundleActivateResult,
  BundleRollbackResult, BundleUnpublishResult, BundleDeleteResult,
  BundleListResult, ReleaseQueued, ReleaseDryRun, ReleaseJobStatus,
  ReleaseStatus, ReleaseBackup, ReleaseRollbackVersioned,
  ReleaseRollbackLegacy, TestStageStatus, TestWipeResult,
  DomainRecord, DnsRecord, DnsInstructions, DomainPreviewResult,
  DomainAddResult, DomainVerifyResult, DelegationConfig, WhitelistEntry,
  ReceivedDelegation, SubDomainEntry, TestPatternResult,
  DomainBindRequest, ReceivedBindRequest,
} from "./deploy.js";
export { PublicFormClient } from "./publicform.js";
export type {
  PublicFormSubmitInput, PublicFormSubmitResult, PublicFormFieldDecl,
  PublicFormSchema, PublicFormSetConfigResult, PublicFormRemoveResult,
  PublicFormConfig, PublicFormConfigMap, PublicFormListInput,
  PublicFormSubmission, PublicFormListResult,
} from "./publicform.js";
export { F3Client, F3Level } from "./f3.js";
export { DurableClient, DurableSubscription } from "./durable.js";
export {
  DURABLE_RETRYABLE_CODES, SUBSCRIBE_KEYS_MAX,
  isDurableRetryable, durablePlacement, durableQuota, durableTickDeadline,
} from "./durable.js";
export type {
  DurableSendInput, DurableSendResult, DurableRetryableCode,
  DurableCellTarget, DurableQuotaInfo, DurableTickDeadlineInfo,
  DurableStatsResult, DurableMailGrantInput, DurableMailGrantCreateResult,
  DurableMailGrantRevokeResult, DurableMailGrantRow, DurableMailGrantListResult,
  ResourceKeyPair, DurableSubscribeInput, DurableSubscribeOptions,
  DurableSubscriptionStatus, DurableSubscriptionError, ProjectionRow,
  WebSocketLike,
} from "./durable.js";
export { EmailClient } from "./email.js";
export { EMAIL_DKIM_NOT_CONFIGURED, EMAIL_INVALID_RECIPIENT } from "./email.js";
export type {
  SendEmailInput, SendEmailResult, ListSendsInput, ListInboxInput,
  MarkReadInput, MarkReadResult, DkimCreateInput, DkimCreateResult,
  DkimRecord, DnsRecordsInput, EmailSendRecord, InboxMessage,
  // MUST stay aliased: ./deploy.js exports an unrelated `DnsRecord`.
  DnsRecord as EmailDnsRecord,
} from "./email.js";
export { ChatClient, ChatSocket, chatResumeCursor } from "./chat.js";
export type {
  ChatHistoryInput, ChatHistoryResult, ChatMessage, ChatServerEvent,
  ChatWsMsgEvent, ChatWsDeletedEvent, ChatWsWelcomeEvent, ChatWsPongEvent,
  ChatWsErrorEvent, ChatConnectOptions, ChatWebSocketLike,
  ChatRoomMinLevel, ChatRoomScopeAttrs, ChatRoomConfigInput,
  ChatRoomConfigResult, ChatSetRoomConfigInput, ChatSetRoomConfigResult,
  ChatRemoveRoomConfigResult,
} from "./chat.js";
export { BillingClient } from "./billing.js";
export type {
  CatalogPlan, CatalogService, BillingMoney, PaymentProvider, BillingCatalog,
  HeldSubscription, BillingAccountStatus,
  CheckoutInput, CheckoutResult,
  ChangePlanInput, PreviewChangePlanResult, ChangePlanResult,
  AppRightsPack, AppRightsBalance, AppRightsPacksResult,
  AppRightsCheckoutInput, AppRightsCheckoutResult,
  CreditPack, CreditsPacksResult, CreditsCheckoutInput, CreditsCheckoutResult,
  CreditsBalance, CreditsLedgerInput, CreditsLedgerEntry, CreditsLedgerResult,
  BillingSubscriptionSummary, PaidSubscriptionOrder, PaidCreditOrder,
  InvoiceSummary, BillingHistory,
  InvoiceIssueInput, InvoiceIssueData, InvoiceIssueResult,
  InvoiceGetInput, InvoiceLineItem, InvoiceDetail,
  InvoiceEmailInput, InvoiceEmailResult,
  ServiceCatalogEntry, ServiceRedeemResult,
  UserLicenseSummary, AppLicenseSummary, LicenseInfo, LicenseTier,
  LicenseAppUsageEntry, LicenseUsageReport,
  UserLicenseUpgradePreview, AppLicenseUpgradePreview, LicenseUpgradePreview,
  LicenseUpgradeRequest, LicenseTokenEntry, SetupTenantInput, SetupTenantResult,
} from "./billing.js";
export { AccountClient } from "./account.js";
export * from "./errors.js";
export * from "./types.js";
