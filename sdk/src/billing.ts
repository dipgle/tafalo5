// BillingClient — public service catalog, self-service subscriptions,
// prepaid credits, invoices (`/billing/*`), PLUS the platform's older
// per-tier license system (`/license`, `/license/*`, `/licenses/*`,
// `/app/upgrade-license/*`). Both are live and both are folded into one
// client here because they share this file's scope per the porting brief.
//
// TWO COEXISTING QUOTA/BILLING SYSTEMS (verified in the Rust source — this
// is not a modeling choice, the server genuinely has both):
//   - The NEW service-catalog model (`services` ⋈ `service_plans`,
//     everything under `/billing/*`): a marketing-page catalog, checkout
//     against a payment provider, mid-period plan changes, prepaid
//     credits, and invoices. See `catalog()` through `invoiceEmail()`.
//   - The LEGACY per-tier `licenses` table (`/license*`, `/licenses/*`,
//     `/app/upgrade-license/*`): one tier per user/app, an operator
//     approval queue for upgrade requests, and a signed HS256
//     license-token redeem flow. See `licenseStatus()` through
//     `cancelLicenseUpgradeRequest()`.
// A given deployment may only really use one of the two in practice, but
// the wire contract for both is live, so both are covered.
//
// MONEY: every `*_cents` field is an INTEGER in the smallest currency unit
// (never a float) — `price_cents`, `amount_cents`, `subtotal_cents`,
// `vat_cents`, `total_cents`. Prepaid CREDITS are a SEPARATE unit —
// `credit_amount` / `balance` in the credits section are a virtual
// "credits"/"tokens" count the platform holds custodially, NOT currency;
// don't conflate the two even though both are plain `number`s.
//
// OUT OF SCOPE — deliberately NOT wrapped here (operator/platform-admin
// only, never self-service; see each citation for the code that enforces
// this):
//   - `POST /billing/webhook/:provider` — the payment-provider settlement
//     webhook. Ships DARK by default: `PaymentRegistry::from_env`
//     (crates/system/src/payment.rs:132-153) only registers a provider
//     once its secret env var (`TFL5_STRIPE_WEBHOOK_SECRET` etc.) is set,
//     and every call is HMAC-signature-verified against the raw body —
//     this is the payment provider calling tfl5, never an SDK caller.
//   - `POST /billing/refund` — refund.rs's own module doc says it
//     plainly: "Operator-initiated, platform-admin gated. A refund is
//     NEVER self-service — a tenant cannot claw back their own grant /
//     credits." Gated via `require_platform_admin` on the fixed
//     `tfl5-admin` app id (refund.rs:9-12, 125). Also note: even when an
//     operator calls it, it reverses tfl5's OWN ledger/subscription state
//     only — `money_refund` in the response is unconditionally the
//     literal `"not_configured"`; no payment-provider-side refund is
//     triggered (refund.rs:491-493).
//   - `/admin/license/*` (6 routes: request/list, request/approve,
//     request/reject, issue, token/list, token/revoke) — every one
//     `require_platform_admin`-gated (license.rs).
// An operator needing any of the above should call `tfl5.raw(path, body)`
// with an operator session, or a separate internal/operator SDK.

import { UnauthorizedError } from "./errors.js";
import type { ErrorEnvelope } from "./types.js";
import type { HttpCore } from "./http.js";

/**
 * `/license`, `/licenses/usage`, `/licenses/preview-upgrade`,
 * `/licenses/setup-tenant`, `/license/redeem`, and `/license/my-tokens` all
 * answer a missing/expired session with HTTP 200 and body
 * `{isSignout:true, result:true}` instead of HTTP 401 (verified: license.rs
 * lines 80/100, 894/... and license_catalog.rs lines 122/145, 226/278,
 * 404/416 — each handler's `check_login` miss branch). Because the body
 * still carries `result:true`, the transport's generic envelope-unwrap
 * treats it as SUCCESS and resolves instead of throwing. This guard closes
 * that gap the same way `account.ts` does for `/user/*`.
 */
function assertSignedIn<T>(body: T): T {
  if ((body as { isSignout?: boolean }).isSignout) {
    throw new UnauthorizedError(
      "unauthorized",
      "Not signed in (session missing or expired)",
      200,
      body as unknown as ErrorEnvelope,
    );
  }
  return body;
}

// ============================================================
// Public service catalog — GET /billing/catalog (anonymous)
// ============================================================

export interface CatalogPlan {
  plan: string;
  display_name: string | null;
  /** INTEGER MINOR UNITS (cents). */
  price_cents: number;
  billing_period: string;
  features: unknown[];
  limits: Record<string, unknown>;
  display_order: number;
  self_service: boolean;
  /** Matches the platform's signup default tier (`"demo"`). */
  is_default: boolean;
}

export interface CatalogService {
  id: string;
  name: string;
  description: string | null;
  /** e.g. `["app"]`, `["user"]`, or `["app","user"]` — which checkout
   *  `subject_type`s this service accepts. */
  subject_kinds: string[];
  plans: CatalogPlan[];
}

export interface BillingCatalog {
  services: CatalogService[];
}

// ============================================================
// Account status + checkout + plan changes
// ============================================================

export interface BillingAccountStatus {
  apps_used: number;
  user_max_apps: number;
  /** `service_id` -> `plan`, for services where the caller holds an
   *  active USER-subject grant (not app-subject grants). */
  current_plans: Record<string, string>;
}

export interface CheckoutInput {
  /** `"app"` (default) buys a per-app service; `"user"` buys for the
   *  authenticated caller themselves. */
  subject_type?: "app" | "user";
  /** Required when `subject_type` is `"app"` (the default); ignored for `"user"`. */
  app_tid?: string;
  service_id: string;
  plan: string;
  /** e.g. `"binance"`. Only Binance Pay drives an outbound hosted
   *  checkout today (see `checkout_url` etc. below); other providers
   *  create a bare pending order with no hosted page yet. */
  provider?: string;
  /** Same key returns the existing order, never a duplicate. */
  idem_key?: string;
}

export interface CheckoutResult {
  order_ref: string;
  /** INTEGER MINOR UNITS (cents). */
  amount_cents: number;
  provider: string;
  status: "pending";
  idempotent?: boolean;
  // Present only for a configured Binance Pay checkout.
  checkout_url?: string;
  qrcode_link?: string;
  qr_content?: string;
  prepay_id?: string;
  expire_time?: number;
  currency?: string;
}

export interface ChangePlanInput {
  app_tid: string;
  service_id: string;
  /** The plan to switch TO. */
  plan: string;
}

export interface ChangePlanResult {
  old_plan: string;
  plan: string;
  /** Net cents settled through the credit ledger: positive = debited
   *  (upgrade), negative = credited back (downgrade), 0 = no movement. */
  net_cents: number;
  settlement: "debit" | "credit" | "none";
  current_period_end: number | null;
}

// ============================================================
// App-creation-rights packs (buy the right to create more apps)
// ============================================================

export interface AppRightsPack {
  id: number;
  quantity: number;
  /** INTEGER MINOR UNITS (cents). */
  unit_price_cents: number;
  /** `quantity * unit_price_cents`, cents. */
  pack_total: number;
  valid_from: number;
  valid_to: number | null;
}

export interface AppRightsBalance {
  app_create_rights: number | null;
  apps_created_total: number;
  /** `null` when `app_create_rights` is unset (legacy account — the UI
   *  should fall back to the license/plan cap for a display value). */
  remaining: number | null;
}

export interface AppRightsPacksResult {
  /** Only packs currently buyable (`active` AND now within the sale window). */
  packs: AppRightsPack[];
  balance: AppRightsBalance;
}

export interface AppRightsCheckoutInput {
  pack_id: number;
  idem_key?: string;
}

export interface AppRightsCheckoutResult {
  order_ref: string;
  quantity: number;
  /** INTEGER MINOR UNITS (cents). */
  amount_cents: number;
  provider: string;
  status: "pending";
  idempotent?: boolean;
  checkout_url?: string;
  qrcode_link?: string;
  qr_content?: string;
  prepay_id?: string;
  expire_time?: number;
  currency?: string;
}

// ============================================================
// Prepaid credits (a custodial virtual-token ledger — NOT currency)
// ============================================================

export interface CreditsCheckoutInput {
  app_tid: string;
  /** Credits to grant when paid. A VIRTUAL prepaid unit ("credits"/
   *  "tokens"), NOT money. Must be > 0. */
  credit_amount: number;
  /** Money to charge, INTEGER MINOR UNITS (cents). The price side of the
   *  purchase — unrelated in magnitude to `credit_amount`. */
  amount_cents?: number;
  currency?: string;
  provider?: string;
  idem_key?: string;
}

export interface CreditsCheckoutResult {
  order_ref: string;
  credit_amount: number;
  amount_cents: number;
  provider: string;
  status: "pending";
  idempotent?: boolean;
}

export interface CreditsBalance {
  /** In CREDIT UNITS (the same unit as `credit_amount` above) — NOT cents. */
  balance: number;
}

// ============================================================
// History + invoices
// ============================================================

export interface BillingSubscriptionSummary {
  service_id: string;
  plan: string;
  status: string;
  current_period_end: number | null;
  provider: string | null;
  provider_ref: string | null;
  updated_at: number;
}

export interface PaidSubscriptionOrder {
  order_ref: string;
  kind: "subscription";
  service_id: string;
  plan: string;
  amount_cents: number;
  currency: string;
  status: string;
  provider: string;
  updated_at: number;
}

export interface PaidCreditOrder {
  order_ref: string;
  kind: "credit";
  /** Credit units, not cents. */
  credit_amount: number;
  amount_cents: number;
  currency: string;
  status: string;
  provider: string;
  updated_at: number;
}

export interface InvoiceSummary {
  invoice_no: string;
  order_ref: string | null;
  kind: string;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  currency: string;
  vat_rate_bps: number;
  status: string;
  provider: string | null;
  provider_ref: string | null;
  created_at: number;
  issued_at: number | null;
}

export interface BillingHistory {
  subscriptions: BillingSubscriptionSummary[];
  /** Credit units, not cents. */
  credit_balance: number;
  paid_orders: {
    subscription: PaidSubscriptionOrder[];
    credit: PaidCreditOrder[];
  };
  /** Most-recent 20 of each category — this endpoint has NO pagination
   *  cursor (a fixed snapshot, not a paged list). */
  invoices: InvoiceSummary[];
}

export interface InvoiceIssueInput {
  app_tid: string;
  /** The PAID order to invoice (a subscription or credit `order_ref`). */
  order_ref: string;
  /** Basis points (1000 = 10%). Omit to use the platform default. */
  vat_rate_bps?: number;
}

export interface InvoiceIssueData {
  invoice_no: string;
  /**
   * Present on a FRESH issue. A known asymmetry in the server response:
   * the IDEMPOTENT-REPLAY path (re-issuing for an already-invoiced
   * `order_ref`) omits this key entirely — don't assume its presence,
   * check `idempotent` on the outer result instead if you need to know
   * which path you got.
   */
  order_ref?: string;
  kind: string;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  currency: string;
  vat_rate_bps: number;
  status: string;
  provider: string | null;
  provider_ref: string | null;
}

export interface InvoiceIssueResult {
  data: InvoiceIssueData;
  /** `true` when this call returned an already-existing invoice instead
   *  of creating one (re-issuing for the same `order_ref` never creates
   *  a second invoice — enforced both in application logic and by a DB
   *  uniqueness constraint). */
  idempotent?: boolean;
  /** Only set on a fresh issue (opt-in server config,
   *  `TFL5_BILLING_AUTO_EMAIL_RECEIPT`, default off ⇒ `"disabled"`):
   *  `"disabled" | "not_configured" | "no_owner_email" | "already_emailed"
   *  | "sent" | "send_failed" | "error"`. */
  receipt_email?: string;
  /** E-invoice connector outcome: `"not_configured"` (default — no
   *  connector wired) | `"issued"` | the literal string
   *  `` `connector_error: <raw provider error message>` `` — NOT a
   *  fixed enum, embeds whatever the connector returned. */
  e_invoice: string;
}

export interface InvoiceGetInput {
  app_tid: string;
  /** One of `invoice_no` / `order_ref` is required. */
  invoice_no?: string;
  order_ref?: string;
}

export interface InvoiceLineItem {
  description: string;
  order_ref: string | null;
  amount_cents: number;
}

export interface InvoiceDetail {
  invoice_no: string;
  order_ref: string | null;
  kind: string;
  status: string;
  currency: string;
  vat_rate_bps: number;
  created_at: number;
  issued_at: number | null;
  provider: string | null;
  provider_ref: string | null;
  /** Always exactly one entry today (one order per invoice). */
  line_items: InvoiceLineItem[];
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
}

export interface InvoiceEmailInput {
  app_tid: string;
  invoice_no?: string;
  order_ref?: string;
  /** Force a re-send even if already emailed. Default `false` — a repeat
   *  call is then a no-op (claimed atomically, so two concurrent calls
   *  can't double-send either). */
  resend?: boolean;
}

export interface InvoiceEmailResult {
  emailed: boolean;
  email: "sent" | "not_configured" | "no_owner_email" | "already_emailed" | "send_failed";
  invoice_no: string;
}

// ============================================================
// Legacy per-tier license system
// ============================================================

export interface UserLicenseSummary {
  tid: string;
  name: string | null;
  max_apps: number;
  max_total_storage: number;
}

export interface AppLicenseSummary {
  tid: string;
  name: string | null;
  max_storage_per_app: number;
}

export interface LicenseInfo {
  user: UserLicenseSummary;
  app: AppLicenseSummary;
  used: { apps: number; storage: number };
  remaining: {
    apps: number;
    storage: number;
    /** Only present when `appTid` was passed to `licenseStatus()`. */
    storage_per_app?: number;
  };
}

export interface LicenseTier {
  tid: string;
  name: string;
  description: string | null;
  user_max_apps: number;
  user_max_total_storage: number;
  app_max_storage: number;
  /** INTEGER MINOR UNITS (cents). */
  price_cents: number;
  billing_period: string;
  features: unknown[];
  self_service_max: boolean;
  display_order: number;
}

export interface LicenseAppUsageEntry {
  tid: string;
  name: string;
  license_tid: string;
  used_storage: number;
  app_max_storage: number;
}

export interface LicenseUsageReport {
  user: {
    tid: string;
    license_tid: string;
    license_name: string | null;
    app_count: number;
    max_apps: number;
    used_storage: number;
    max_total_storage: number;
    app_max_storage: number;
  };
  /** Only apps the caller OWNS (author), not apps they merely manage/read. */
  apps: LicenseAppUsageEntry[];
}

export interface UserLicenseUpgradePreview {
  target: "user";
  current: {
    license_tid: string;
    license_name: string | null;
    max_apps: number;
    max_total_storage: number;
    app_max_storage: number;
    app_count: number;
    used_storage: number;
  };
  after: {
    license_tid: string;
    license_name: string;
    max_apps: number;
    max_total_storage: number;
    app_max_storage: number;
  };
  delta: { apps: number; storage: number; app_max_storage: number };
}

export interface AppLicenseUpgradePreview {
  target: "app";
  app_tid: string;
  current: {
    license_tid: string;
    license_name: string | null;
    app_max_storage: number;
    used_storage: number;
  };
  after: { license_tid: string; license_name: string; app_max_storage: number };
  delta: { app_max_storage: number };
}

/** No price is surfaced here — quota deltas only. Cross-reference
 *  `licenseCatalog()` for `price_cents` if you need to show a price delta. */
export type LicenseUpgradePreview = UserLicenseUpgradePreview | AppLicenseUpgradePreview;

export interface LicenseUpgradeRequest {
  tid: string;
  app_tid: string;
  target: "app" | "user";
  target_tid: string;
  requested_tier: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requester_tid: string;
  reason: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  created_at: number;
}

export interface LicenseTokenEntry {
  token_hash: string;
  plan: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  redeemed_at: number | null;
}

export interface SetupTenantInput {
  /** Tier to promote to. Omit to run the wizard idempotently (returns the
   *  current state without committing anything). */
  wanted_user_tier?: string;
}

export type SetupTenantResult =
  | { noop: true; current_tier: string; reason?: "already_upgraded" }
  | { upgraded: true; from: string; to: string };

// ============================================================
// Client
// ============================================================

export class BillingClient {
  constructor(private readonly http: HttpCore) {}

  // ---- Public service catalog (anonymous) ------------------------------

  /**
   * Fetch the active services + their catalog-visible plans (price,
   * period, feature bullets, resolved limits, self-service flag). No auth
   * required — safe for an anonymous marketing/pricing page.
   *
   * Uses `HttpCore.get()`: the route is mounted **GET-only** server-side
   * (`billing.rs`: `.route("/billing/catalog", get(catalog))`).
   */
  async catalog(): Promise<BillingCatalog> {
    return (await this.http.get<BillingCatalog>("/billing/catalog")) ?? { services: [] };
  }

  // ---- Self-service account status / checkout / plan changes ------------

  /** The authenticated caller's own app-creation quota + which USER-subject
   *  plans they currently hold (drives the "✓ Current" marker on a pricing
   *  card). */
  account(): Promise<BillingAccountStatus> {
    return this.http.post<BillingAccountStatus>("/billing/account");
  }

  /**
   * Create a pending order for a (service, plan) — either an app-subject
   * purchase (default; caller must be Owner of `app_tid`) or a user-subject
   * purchase for the caller themselves (requires a verified email either
   * way). Returns an `order_ref`; a paid settlement (via the dark webhook)
   * activates the grant. Idempotent on `idem_key`.
   */
  checkout(input: CheckoutInput): Promise<CheckoutResult> {
    return this.http.post<CheckoutResult>("/billing/checkout", input);
  }

  /**
   * Switch an app-subject subscription to a different plan mid-period.
   * The prorated difference settles through the prepaid-credit ledger in
   * the SAME transaction as the plan flip (atomic): an upgrade debits the
   * difference, a downgrade credits it back.
   *
   * Throws `code: "insufficient_credits"` (HTTP 402) if the credit balance
   * can't cover an upgrade's debit — nothing flips in that case. Throws
   * `code: "conflict"` (400) if the subscription/plan changed concurrently
   * between read and write (lost a race — safe to retry).
   */
  changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    return this.http.post<ChangePlanResult>("/billing/subscription/change-plan", input);
  }

  // ---- App-creation-rights packs -----------------------------------------

  /** The currently-buyable app-creation-rights packs plus the caller's own
   *  balance. Login required (buys are always for self). */
  appRightsPacks(): Promise<AppRightsPacksResult> {
    return this.http.post<AppRightsPacksResult>("/billing/app-rights/packs");
  }

  /**
   * Buy a pack of app-creation rights for yourself (there is no
   * `app_tid`/`subject_type` here — always the caller). Throws
   * `code: "pack_not_buyable"` if the pack is inactive or outside its sale
   * window (re-checked server-side regardless of what the UI shows).
   * Idempotent on `idem_key`.
   */
  appRightsCheckout(input: AppRightsCheckoutInput): Promise<AppRightsCheckoutResult> {
    return this.http.post<AppRightsCheckoutResult>("/billing/app-rights/checkout", input);
  }

  // ---- Prepaid credits ----------------------------------------------------

  /**
   * Create a pending order to top up an app's prepaid credit balance.
   * Owner-gated (app-subject only — no user wallet yet). `credit_amount`
   * must be > 0. Idempotent on `idem_key`, scoped per-app.
   */
  creditsCheckout(input: CreditsCheckoutInput): Promise<CreditsCheckoutResult> {
    return this.http.post<CreditsCheckoutResult>("/billing/credits/checkout", input);
  }

  /** The app's current prepaid credit balance (0 if none yet). Owner-gated. */
  creditsBalance(appTid: string): Promise<CreditsBalance> {
    return this.http.post<CreditsBalance>("/billing/credits/balance", { app_tid: appTid });
  }

  // ---- History + invoices ------------------------------------------------

  /**
   * A snapshot for the app's billing page: active subscriptions, the
   * credit balance, the most-recent 20 paid orders per purchase model, and
   * the most-recent 20 invoices. Owner (author) only — Managers of the app
   * cannot call this, or any other `/billing/invoice/*` / `/billing/history`
   * endpoint (all Owner-gated).
   */
  history(appTid: string): Promise<BillingHistory> {
    return this.http.post<BillingHistory>("/billing/history", { app_tid: appTid });
  }

  /**
   * Issue an invoice for a PAID order. Re-issuing for the same `order_ref`
   * is idempotent — returns the existing invoice, never creates a second
   * one (enforced both in application logic and by a DB constraint).
   *
   * Implemented via a raw `fetch`, not `HttpCore.post()`: the success
   * envelope carries `receipt_email` / `e_invoice` as SIBLINGS of `data`
   * (not nested inside it), so this uses `HttpCore.postFull()`; plain
   * `post()` returns only the `data` key and would drop those two fields.
   */
  async invoiceIssue(input: InvoiceIssueInput): Promise<InvoiceIssueResult> {
    const body = await this.http.postFull<{
      data?: InvoiceIssueData;
      idempotent?: boolean;
      receipt_email?: string;
      e_invoice?: string;
    }>("/billing/invoice/issue", input);
    if (!body.data) {
      throw new Error("@tfl5/sdk: /billing/invoice/issue returned no data payload");
    }
    return {
      data: body.data,
      idempotent: body.idempotent,
      receipt_email: body.receipt_email,
      e_invoice: body.e_invoice ?? "not_configured",
    };
  }

  /** Fetch one invoice's full detail (including its single line item). */
  invoiceGet(input: InvoiceGetInput): Promise<InvoiceDetail> {
    return this.http.post<InvoiceDetail>("/billing/invoice/get", input);
  }

  /**
   * Download an invoice as a rendered PDF (`application/pdf` bytes).
   *
   * Implemented via a raw `fetch`, not `HttpCore.post()`: `HttpCore.post()`
   * always calls `res.json()` on the response body, which would consume
   * and fail on a binary PDF body and resolve to `undefined`.
   *
   * In **cookie mode** (browser) this works transparently — the browser
   * attaches the session cookie to the same-origin request automatically.
   * In **bearer mode** (Node/CLI) `HttpCore`'s stored token is private with
   * Returns raw PDF bytes, so it goes through `HttpCore.postRaw()` — plain
   * `post()` calls `res.json()` and would destroy the binary body.
   */
  async invoicePdf(input: InvoiceGetInput): Promise<Blob> {
    const { bytes, mimeType } = await this.http.postRaw("/billing/invoice/pdf", input);
    return new Blob([bytes], { type: mimeType ?? "application/pdf" });
  }

  /**
   * Email the receipt/invoice to the app owner's own resolved primary
   * email (never an arbitrary address you pass in). Idempotent unless
   * `resend: true`. The email is inline text/HTML only — no PDF
   * attachment; point the recipient at `invoicePdf()` separately if you
   * need one.
   */
  invoiceEmail(input: InvoiceEmailInput): Promise<InvoiceEmailResult> {
    return this.http.post<InvoiceEmailResult>("/billing/invoice/email", input);
  }

  // ---- Legacy per-tier license system -------------------------------------

  /**
   * The caller's current license tier + usage + remaining headroom. Pass
   * `appTid` (caller needs at least Reader on it) to include that app's
   * per-app storage remaining too.
   */
  async licenseStatus(appTid?: string): Promise<LicenseInfo> {
    return assertSignedIn(
      await this.http.post<LicenseInfo>("/license", appTid ? { app_tid: appTid } : {}),
    );
  }

  /** The legacy per-tier catalog (distinct from {@link catalog}, the newer
   *  service-catalog model). Anonymous — no auth required. */
  licenseCatalog(): Promise<{ tiers: LicenseTier[] }> {
    return this.http.post<{ tiers: LicenseTier[] }>("/licenses/catalog", {});
  }

  /** Detailed usage: tier limits, app count, storage, and a per-app
   *  breakdown (apps the caller owns). */
  async licenseUsage(): Promise<LicenseUsageReport> {
    return assertSignedIn(await this.http.post<LicenseUsageReport>("/licenses/usage"));
  }

  /**
   * Dry-run a legacy-tier upgrade to see the before/after quota deltas
   * without committing anything. Pass `target: "user"` for a user-level
   * upgrade, or `"app"` with `appTid` (caller needs at least Reader on it)
   * for a per-app upgrade.
   */
  async previewLicenseUpgrade(
    target: "user" | "app",
    requestedTier: string,
    appTid?: string,
  ): Promise<LicenseUpgradePreview> {
    return assertSignedIn(
      await this.http.post<LicenseUpgradePreview>("/licenses/preview-upgrade", {
        target,
        requested_tier: requestedTier,
        ...(appTid ? { app_tid: appTid } : {}),
      }),
    );
  }

  /**
   * First-tenant self-service wizard: the first registered user (sole
   * Manager of the fixed `tfl5-admin` app) may self-promote their user
   * tier up to whichever tier is marked `self_service_max` in the catalog
   * — no billing/approval needed. Every other user is refused with
   * `code: "not_first_user"`.
   *
   * Omit `wanted_user_tier` to probe the current state idempotently
   * (`{noop:true, current_tier}`) without committing. Calling it again
   * after a successful upgrade is also a no-op
   * (`{noop:true, current_tier, reason:"already_upgraded"}`), not an error.
   */
  async setupTenant(input: SetupTenantInput = {}): Promise<SetupTenantResult> {
    return assertSignedIn(
      await this.http.post<SetupTenantResult>("/licenses/setup-tenant", input),
    );
  }

  /**
   * Redeem a signed HS256 license token. The token must be bound to the
   * caller's own `user_tid`, unexpired, unrevoked, not already redeemed,
   * and its `plan` must reference an existing tier. On success
   * `users.license_tid` flips immediately — no restart required.
   *
   * Throws (all HTTP 200, `.code` distinguishes the reason):
   * `license_token_not_configured`, `license_token_expired`,
   * `license_token_invalid` (bad signature OR issuer/audience mismatch —
   * same code for both), `license_token_subject_mismatch` (token was
   * minted for a different account), `license_token_unknown`,
   * `license_token_revoked`, `license_token_already_redeemed`,
   * `license_token_plan_unknown` (operator hasn't provisioned that tier
   * row yet), `license_token_race` (lost a concurrent redeem — retry).
   */
  async redeemLicenseToken(token: string): Promise<{ plan: string }> {
    const body = assertSignedIn(
      await this.http.post<{ plan?: string }>("/license/redeem", { token }),
    );
    return { plan: body.plan ?? "" };
  }

  /** The caller's own license tokens (issued + redemption + revocation
   *  timestamps) — a "My Plan" settings panel. */
  async myLicenseTokens(): Promise<LicenseTokenEntry[]> {
    const body = assertSignedIn(
      await this.http.post<{ tokens?: LicenseTokenEntry[] }>("/license/my-tokens"),
    );
    return body.tokens ?? [];
  }

  /**
   * File a legacy-tier upgrade request with the operator (decouples "I
   * want pro" from actually billing it — an operator approves/rejects via
   * the separate operator surface). Requires Manager on `appTid` for
   * either target. Refuses (plain message, no `.code`) a duplicate pending
   * request for the same target, an unknown tier, or an invalid `target`.
   */
  requestLicenseUpgrade(
    appTid: string,
    target: "app" | "user",
    requestedTier: string,
    reason?: string,
  ): Promise<{ tid: string; status: "pending" }> {
    return this.http.post("/app/upgrade-license", {
      app_tid: appTid,
      target,
      requested_tier: requestedTier,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * List upgrade requests filed from `appTid` (Reader permission is
   * enough). `appTid` is passed explicitly and always required by the
   * server — don't rely on `useApp()`'s auto-injection here.
   */
  listLicenseUpgradeRequests(appTid: string): Promise<LicenseUpgradeRequest[]> {
    return this.http.post<LicenseUpgradeRequest[]>("/app/upgrade-license/list", {
      app_tid: appTid,
    });
  }

  /** Cancel a pending upgrade request filed from `appTid`. Requires Manager. */
  cancelLicenseUpgradeRequest(appTid: string, tid: string): Promise<{ cancelled: boolean }> {
    return this.http.post("/app/upgrade-license/cancel", { app_tid: appTid, tid });
  }
}
