// BillingClient — `/billing/*` and `/service/*`: what the platform sells,
// checkout, prepaid credits, invoices and entitlement tokens.
//
// Money is always an integer in the currency's minor unit (`*_cents`).
// Read `currency` and `minor_units` from the response to format it — some
// currencies (VND, JPY) have 0 decimal places. Never assume 2.
//
// Payment settles asynchronously through the provider's webhook; a checkout
// returns a `pending` order and, for hosted providers, a payment URL / QR.

import type { HttpCore } from "./http.js";

export interface Money {
  currency: string;
  minor_units: number;
}

export interface CatalogPlan {
  plan: string;
  display_name: string;
  price_cents: number;
  currency: string;
  vat_rate_bps: number;
  vat_cents: number;
  total_cents: number;
  billing_period: string;
  features: unknown[];
  limits: Record<string, unknown>;
  display_order: number;
  self_service: boolean;
  is_default: boolean;
}

export interface BillingCatalog {
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    subject_kinds: string[];
    plans: CatalogPlan[];
  }>;
  money: Money & { vat_rate_bps: number; prices_include_vat: boolean };
  payment_providers: Array<{ id: string; settles: boolean; hosted_checkout: boolean }>;
}

export interface CheckoutOrder {
  order_ref: string;
  amount_cents: number;
  currency: string;
  provider: string;
  status: "pending";
  /** Hosted-checkout providers only. */
  checkout_url?: string;
  qrcode_link?: string;
  qr_content?: string;
  prepay_id?: string;
  expire_time?: number;
  [k: string]: unknown;
}

export interface AccountStatus {
  apps_used: number;
  user_max_apps: number;
  current_plans: Record<string, string>;
  current_subscriptions: Record<string, { plan: string; status: string; current_period_end: number | null }>;
  model: "rights" | "plan";
  effective_cap: number;
  apps_created_total: number;
  remaining: number;
  refundable_on_delete: boolean;
  [k: string]: unknown;
}

export interface PlanChangeQuote {
  service_id: string;
  from_plan: string;
  to_plan: string;
  cadence_change: boolean;
  refund_cents: number;
  due_cents: number;
  new_period_end: number;
  net_cents: number;
  settlement: "debit" | "credit" | "none";
  currency: string;
  credit_balance: number;
  sufficient_credit: boolean;
  as_of: number;
}

export interface Invoice {
  invoice_no: string;
  order_ref: string;
  kind: "subscription" | "credit";
  status: string;
  currency: string;
  vat_rate_bps: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  provider: string;
  provider_ref: string | null;
  created_at?: number;
  issued_at?: number;
  line_items?: Array<{ description: string; order_ref: string; amount_cents: number }>;
  [k: string]: unknown;
}

type InvoiceRef = { invoiceNo: string } | { orderRef: string };
const invoiceRefBody = (ref: InvoiceRef) =>
  "invoiceNo" in ref ? { invoice_no: ref.invoiceNo } : { order_ref: ref.orderRef };

/** Prepaid credits held for an app (Owner). */
export class CreditsClient {
  constructor(private readonly http: HttpCore) {}

  /** Credit packs on sale now (any signed-in user). */
  packs(): Promise<{
    packs: Array<{ id: number; credits: number; price_cents: number; valid_from: number | null; valid_to: number | null }>;
    currency: string;
  }> {
    return this.http.post("/billing/credits/packs", {});
  }

  /** Buy a pack for the scoped app. Refused with `pack_not_buyable` if it is not on sale. */
  checkout(input: { packId: number; provider?: string; idemKey?: string }): Promise<
    CheckoutOrder & { credit_amount: number; pack_id: number }
  > {
    return this.http.post("/billing/credits/checkout", {
      pack_id: input.packId,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.idemKey !== undefined ? { idem_key: input.idemKey } : {}),
    });
  }

  /** Current balance of the scoped app. */
  async balance(): Promise<number> {
    const r = await this.http.post<{ balance: number }>("/billing/credits/balance", {});
    return r.balance;
  }

  /** Ledger entries, newest first. Page with `beforeId`; `limit` 1–200 (default 50). */
  ledger(opts: { beforeId?: number; limit?: number } = {}): Promise<{
    entries: Array<{ id: number; delta: number; reason: string; ref: string | null; balance_after: number; created_at: number }>;
    has_more: boolean;
  }> {
    return this.http.post("/billing/credits/ledger", {
      ...(opts.beforeId !== undefined ? { before_id: opts.beforeId } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }
}

/** Invoices for the scoped app's paid orders (Owner). */
export class InvoicesClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Issue the invoice for a paid order. Idempotent per `orderRef`.
   * `vatRateBps` defaults to 1000 (10%).
   */
  async issue(input: { orderRef: string; vatRateBps?: number }): Promise<
    Invoice & {
      /** `true` when the invoice already existed for this order. */
      idempotent?: boolean;
      /** E-invoice connector outcome: `not_configured`, `issued`, or an error text. */
      e_invoice?: string;
      /** Receipt email outcome: `sent`, `disabled`, `not_configured`, `no_owner_email`, `already_emailed`, `error`. */
      receipt_email?: string;
    }
  > {
    const env = await this.http.postEnvelope<{
      data: Invoice;
      idempotent?: boolean;
      e_invoice?: string;
      receipt_email?: string;
    }>("/billing/invoice/issue", {
      order_ref: input.orderRef,
      ...(input.vatRateBps !== undefined ? { vat_rate_bps: input.vatRateBps } : {}),
    });
    return {
      ...env.data,
      ...(env.idempotent !== undefined ? { idempotent: env.idempotent } : {}),
      ...(env.e_invoice !== undefined ? { e_invoice: env.e_invoice } : {}),
      ...(env.receipt_email !== undefined ? { receipt_email: env.receipt_email } : {}),
    };
  }

  /** Fetch an invoice by number or by order reference. */
  get(ref: InvoiceRef): Promise<Invoice> {
    return this.http.post<Invoice>("/billing/invoice/get", invoiceRefBody(ref));
  }

  /** The invoice as a PDF. */
  pdf(ref: InvoiceRef): Promise<Blob> {
    return this.http.postBlob("/billing/invoice/pdf", invoiceRefBody(ref));
  }

  /**
   * Email the invoice to the app owner. Sent once unless `resend: true`;
   * `email` reports `sent` / `already_emailed` / `not_configured` / `no_owner_email`.
   */
  email(ref: InvoiceRef, opts: { resend?: boolean } = {}): Promise<{
    emailed: boolean;
    email: "sent" | "not_configured" | "no_owner_email" | "already_emailed" | "send_failed";
    invoice_no: string;
  }> {
    return this.http.post("/billing/invoice/email", {
      ...invoiceRefBody(ref),
      ...(opts.resend ? { resend: true } : {}),
    });
  }
}

export class BillingClient {
  readonly credits: CreditsClient;
  readonly invoices: InvoicesClient;

  constructor(private readonly http: HttpCore) {
    this.credits = new CreditsClient(http);
    this.invoices = new InvoicesClient(http);
  }

  /** Public catalog of services, plans and prices (no sign-in needed). */
  catalog(): Promise<BillingCatalog> {
    return this.http.get<BillingCatalog>("/billing/catalog");
  }

  /** The signed-in user's app allowance and current plans. */
  account(): Promise<AccountStatus> {
    return this.http.post<AccountStatus>("/billing/account", {});
  }

  /**
   * Start a subscription order. For an app (`subject: "app"`, the default)
   * the caller must own the scoped app; `subject: "user"` buys for yourself
   * and needs a verified email.
   */
  checkout(input: {
    serviceId: string;
    plan: string;
    subject?: "app" | "user";
    provider?: string;
    idemKey?: string;
  }): Promise<CheckoutOrder> {
    return this.http.post<CheckoutOrder>("/billing/checkout", {
      service_id: input.serviceId,
      plan: input.plan,
      ...(input.subject !== undefined ? { subject_type: input.subject } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.idemKey !== undefined ? { idem_key: input.idemKey } : {}),
    });
  }

  /** Packs of app-creation rights on sale, with your current balance. */
  appRightsPacks(): Promise<{
    packs: Array<{ id: number; quantity: number; unit_price_cents: number; pack_total: number; valid_from: number | null; valid_to: number | null }>;
    money: Money;
    balance: { app_create_rights: number; apps_created_total: number; remaining: number };
  }> {
    return this.http.post("/billing/app-rights/packs", {});
  }

  /** Buy a pack of app-creation rights for yourself (verified email needed). */
  appRightsCheckout(input: { packId: number; idemKey?: string }): Promise<CheckoutOrder & { quantity: number }> {
    return this.http.post("/billing/app-rights/checkout", {
      pack_id: input.packId,
      ...(input.idemKey !== undefined ? { idem_key: input.idemKey } : {}),
    });
  }

  /** Quote switching the scoped app's subscription to another plan (Owner). */
  previewPlanChange(input: { serviceId: string; plan: string }): Promise<PlanChangeQuote> {
    return this.http.post<PlanChangeQuote>("/billing/subscription/preview-change", {
      service_id: input.serviceId,
      plan: input.plan,
    });
  }

  /**
   * Switch plans now, settling the difference against the app's credits.
   * Refused with `insufficient_credits` (402) when an upgrade costs more
   * than the balance, and `conflict` on a concurrent change.
   */
  changePlan(input: { serviceId: string; plan: string }): Promise<{
    old_plan: string;
    plan: string;
    net_cents: number;
    currency: string;
    settlement: "debit" | "credit" | "none";
    current_period_end: number;
  }> {
    return this.http.post("/billing/subscription/change-plan", {
      service_id: input.serviceId,
      plan: input.plan,
    });
  }

  /** Subscriptions, paid orders, invoices and credit balance of the scoped app (Owner). */
  history(): Promise<Record<string, unknown>> {
    return this.http.post("/billing/history", {});
  }

  /** Services an entitlement token can grant (any signed-in user). */
  services(): Promise<Array<{ id: string; name: string; subject_kinds: string[]; plans: unknown[] }>> {
    return this.http.post("/service/list", {});
  }

  /**
   * Redeem an entitlement token issued by the platform operator. A user
   * token applies to you; an app token needs you to own that app. One use.
   * Errors: `entitlement_token_invalid`, `entitlement_token_unusable`,
   * `entitlement_token_subject_mismatch`, `entitlement_plan_unknown`.
   */
  redeem(token: string): Promise<{ service_id: string; plan: string; subject_type: string; subject_id: string }> {
    return this.http.post("/service/redeem", { token });
  }
}
