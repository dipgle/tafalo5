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
// A `*_cents` number is NOT renderable on its own. Two things have to
// travel with it, and both are now on the wire:
//   - THE UNIT. `catalog().money.currency` is the platform's ISO-4217
//     code (`invoice.rs:82`, from `TFL5_BILLING_CURRENCY`, default
//     `"USD"` at `invoice.rs:73`), and every checkout result now carries
//     the `currency` of the order it created.
//   - HOW MANY DECIMALS THAT UNIT HAS. `catalog().money.minor_units` is
//     0 for the zero-decimal currencies (VND, JPY, KRW, …) and 3 for a
//     handful of others (`invoice.rs:105-111`). Dividing `*_cents` by 100
//     is therefore WRONG in general — it turns 999 ₫ into "9.99". Divide
//     by `10 ** minor_units`.
// And VAT is added ON TOP of the advertised price:
// `catalog().money.prices_include_vat` is hardcoded `false`
// (`billing.rs:186`), so a plan listed at `price_cents: 999` is invoiced
// at `total_cents: 1099` under the default 1000 bps (`invoice.rs:65`).
// The catalog computes that with the SAME `compute_vat` the invoice uses
// (`billing.rs:151-154`; round-half-up integer math at
// `invoice.rs:143-158`), so the two cannot drift — but it means
// `price_cents` is not the number that gets charged. Show `total_cents`.
//
// REFUSALS — the statuses moved, the `code`s did not. Every refusal in
// this area answers `{result:false, msg, code, timestamp}` with a REAL
// HTTP status; these used to be HTTP 200. The transport throws on any
// `result:false` (`http.ts:254`), and `errors.ts`'s `makeError` has no
// case for these codes, so they all surface as `BadRequestError` whether
// the status was 400 or 402. Switch on `err.code` — never on the error
// class, and never on `err.status`:
//   - `quota_exceeded` — 402, the app-creation cap is exhausted
//     (`app.rs:799-815` consumable branch / `:857-871` legacy branch).
//     Carries a `data` block naming WHICH cap — see
//     {@link BillingAccountStatus}.
//   - `insufficient_credits` — 402, a plan change the prepaid balance
//     cannot cover (`credits.rs:856-867`).
//   - `conflict` — 400, lost a concurrent plan-change race
//     (`billing.rs:1697-1727`). Safe to retry.
//   - `pack_not_buyable` — 400, an unknown / inactive / out-of-window
//     credit pack (`credits.rs:178-181`).
// THREE different mechanisms produce those statuses, so there is no one
// switch that reverts them and a client must not hard-code either number:
//   - `quota_exceeded` goes through `AppError::Refused`
//     (`error.rs:170-178`), which an operator can flip back to HTTP 200
//     with `TFL5_LEGACY_REFUSAL_200=1` (`error.rs:256-264`).
//   - `conflict` / `pack_not_buyable` go through
//     `AppError::BadRequestCode` and are reverted by a SEPARATE flag,
//     `TFL5_LEGACY_BADREQUEST_200=1` (`error.rs:232-239`; the status is
//     chosen at `error.rs:325-328`).
//   - `insufficient_credits` is built as a raw 402 response by
//     `CreditError::into_response` (`credits.rs:856-867`) and consults NO
//     flag — it is always 402, and it is the one refusal here whose body
//     has no `timestamp`.
// A refusal's `data` block is present only when the refusing site
// supplied one: absent stays absent, never `"data": null`
// (`error.rs:394-400`). It is NOT declared on the SDK's `ErrorEnvelope`
// (`types.ts:17-23`), so reading it needs a cast —
// `(err.body as { data?: { cap?: string } }).data`.
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
  /**
   * The ADVERTISED price, INTEGER MINOR UNITS. This is NOT what gets
   * invoiced — VAT is added on top (see `total_cents` below).
   */
  price_cents: number;
  /**
   * ISO-4217 code for this plan's `*_cents` figures (`billing.rs:159`).
   * Per-plan on the wire, but every row is filled from the one
   * platform-wide `platform_currency()`, so it always equals
   * {@link BillingMoney.currency}. Pair it with
   * {@link BillingMoney.minor_units} before formatting — the code alone
   * does not tell you where the decimal point goes.
   */
  currency: string;
  /** VAT rate applied to `price_cents`, in basis points (1000 = 10%). */
  vat_rate_bps: number;
  /** The tax itself, INTEGER MINOR UNITS. */
  vat_cents: number;
  /**
   * `price_cents + vat_cents` — what the invoice will actually total,
   * computed by the SAME `compute_vat` the invoice uses
   * (`billing.rs:151-154`). THIS is the number to put on a pricing card;
   * `price_cents` is the pre-tax figure and is smaller than the charge.
   */
  total_cents: number;
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

/**
 * The money block a renderer needs BEFORE it can print any price
 * (`billing.rs:182-187`).
 *
 * Two traps this exists to close, both of them verifiable in the server:
 *  1. `prices_include_vat` is hardcoded `false` (`billing.rs:186`). The
 *     advertised `price_cents` is NOT what gets invoiced — VAT is added on
 *     top by the same function the invoice uses (`billing.rs:151-154`), so
 *     render {@link CatalogPlan.total_cents}, not `price_cents`.
 *  2. `minor_units` is 0 for the zero-decimal currencies (VND, JPY, KRW,
 *     CLP, ISK, …) and 3 for a few Gulf currencies
 *     (`invoice.rs:105-111`). Dividing `*_cents` by 100 is only right for
 *     the 2-decimal majority; on VND it turns 999 ₫ into "9.99". Always
 *     divide by `10 ** minor_units`.
 */
export interface BillingMoney {
  /**
   * ISO-4217 code every `*_cents` figure in the catalog is denominated in.
   * Defaults to `"USD"` (`invoice.rs:73`) and is overridable per
   * deployment via `TFL5_BILLING_CURRENCY` (`invoice.rs:82-99`) — so it is
   * a per-deployment value, never a constant you may assume.
   */
  currency: string;
  /** Decimal places `currency` carries: 0, 2 or 3. See the caveat above. */
  minor_units: number;
  /** Platform default VAT rate in basis points; 1000 = 10% (`invoice.rs:65`). */
  vat_rate_bps: number;
  /** Always `false` today — the advertised prices are PRE-tax. */
  prices_include_vat: boolean;
}

/**
 * One row of the payment-method picker (`billing.rs:200`, built at
 * `billing.rs:80-88`).
 *
 * EVERY provider is always listed, including ones this deployment has
 * never configured — because "not offered" and "offered but dead" look
 * identical to a customer otherwise. `settles` is the field that says
 * whether a provider can actually take money: with `settles: false` the
 * platform cannot verify that provider's webhook, so an order placed
 * against it can never be recognised as paid. Booleans only; no
 * credential is ever exposed here.
 */
export interface PaymentProvider {
  /** e.g. `"binance"` | `"stripe"` | `"vietqr"`. */
  id: string;
  /** The platform can VERIFY this provider's settlement webhook, i.e. a
   *  payment through it can be recognised. `false` ⇒ orders placed with it
   *  stay pending forever. */
  settles: boolean;
  /** The platform can mint a hosted payment page / QR for this provider.
   *  Only `"binance"` can ever report `true` (`billing.rs:86`), and only
   *  when its checkout client is configured. */
  hosted_checkout: boolean;
}

export interface BillingCatalog {
  services: CatalogService[];
  /** Unit + tax metadata. A price cannot be rendered without it. */
  money: BillingMoney;
  /** Which ways of paying this deployment can actually complete. */
  payment_providers: PaymentProvider[];
}

// ============================================================
// Account status + checkout + plan changes
// ============================================================

/** One held user-subject subscription, as reported by
 *  {@link BillingAccountStatus.current_subscriptions}. */
export interface HeldSubscription {
  plan: string;
  /** `"active"`, or `"suspended"` for one in dunning — still the thing the
   *  customer is on. `"canceled"` rows are excluded server-side
   *  (`billing.rs:498`) because they are not held. */
  status: string;
  /** `null` = open-ended; do NOT render a date for it. */
  current_period_end: number | null;
}

/**
 * `/billing/account` — the caller's own app-creation quota and what they
 * currently hold (`billing.rs:543-563`).
 *
 * ⚠ `user_max_apps` ALONE IS NOT THE CAP THE SERVER ENFORCES for most
 * accounts. The enforced pair is {@link model} + {@link effective_cap}.
 * The create gate resolves the account grant into the consumable balance
 * with `GREATEST` (`app.rs:762-774`), and the two numbers do not even
 * measure the same thing (`app.rs:754-761`):
 *   - `app_create_rights` (`model: "rights"`) is a LIFETIME counter —
 *     deleting an app refunds nothing.
 *   - `user_max_apps` (`model: "plan"`) is a CONCURRENT cap — deleting an
 *     app frees a slot straight away.
 * Quote `effective_cap`/`remaining` and let `refundable_on_delete` decide
 * whether "delete an app to free a slot" is honest advice. A UI that shows
 * `user_max_apps` is quoting a number the gate may not use.
 *
 * The matching refusal is 402 `quota_exceeded`, whose `data` block names
 * which cap was hit — `{cap:"app_create_rights", rights, created,
 * remaining, refundable_on_delete:false}` (`app.rs:808-814`) or
 * `{cap:"user_max_apps", max, used, refundable_on_delete:true}`
 * (`app.rs:865-870`).
 */
export interface BillingAccountStatus {
  /** Apps the caller currently holds (a CONCURRENT count). */
  apps_used: number;
  /**
   * The legacy plan/tier cap. Reported for continuity, but see the type's
   * own warning above: on a `model: "rights"` account this is NOT the
   * number the create gate enforces.
   */
  user_max_apps: number;
  /** `service_id` -> `plan`, for services where the caller holds an
   *  active USER-subject grant (not app-subject grants). This is what is
   *  ENFORCED, however it arrived. */
  current_plans: Record<string, string>;
  /**
   * `service_id` -> what is BEING PAID FOR, from the caller's user-subject
   * `subscriptions` rows (`billing.rs:496-498`). A service present in
   * {@link current_plans} but ABSENT here is held as a GRANT, not a
   * purchase.
   *
   * ⚠ This is the field that lets a client warn before a destructive
   * click. There is NO user-subject proration door: both
   * `previewChangePlan()` and `changePlan()` hardcode `subject_type =
   * "app"` behind an app-Owner gate (`billing.rs:1419`, `:1537`), so
   * buying an ACCOUNT plan the user already holds has to go through
   * {@link BillingClient.checkout} — which does not check for an existing
   * subscription and upserts the row, charging FULL price, resetting the
   * period and forfeiting whatever was left of the old one
   * (`billing.rs:485-491`). Check this map first and say so.
   */
  current_subscriptions: Record<string, HeldSubscription>;
  /** Which gate this account is actually metered by: `"rights"` (a
   *  consumable lifetime balance) or `"plan"` (a concurrent tier cap). */
  model: "rights" | "plan";
  /** The cap the create gate ENFORCES, resolved the way `app.rs` resolves
   *  it. Quote this, not `user_max_apps`. */
  effective_cap: number;
  /** Lifetime apps created — the numerator on the `"rights"` model.
   *  Unaffected by deletions. */
  apps_created_total: number;
  /** `effective_cap` minus what has been consumed, floored at 0:
   *  `apps_created_total` on the `"rights"` model, `apps_used` on
   *  `"plan"`. */
  remaining: number;
  /** `true` only on the `"plan"` model. When `false`, deleting an app
   *  gives NOTHING back and the UI must not suggest it. */
  refundable_on_delete: boolean;
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
  /** INTEGER MINOR UNITS. Pair with {@link currency}. */
  amount_cents: number;
  /**
   * ISO-4217 unit of `amount_cents`. ALWAYS present now, on every
   * provider — it used to be set only on the Binance branch, so every
   * ordinary checkout answered with a number and no unit
   * (`billing.rs:736`).
   *
   * On an idempotent REPLAY this is read from the STORED order
   * (`billing.rs:692`), not from today's price sheet: a replay answers
   * about an order that already exists, and the order's own currency is
   * what settlement will compare against.
   */
  currency: string;
  provider: string;
  status: "pending";
  idempotent?: boolean;
  // Present only for a configured Binance Pay checkout.
  checkout_url?: string;
  qrcode_link?: string;
  qr_content?: string;
  prepay_id?: string;
  expire_time?: number;
}

export interface ChangePlanInput {
  app_tid: string;
  service_id: string;
  /** The plan to switch TO. */
  plan: string;
}

/**
 * What a plan switch WOULD cost — the quote, from
 * `/billing/subscription/preview-change` (`billing.rs:1502-1524`).
 *
 * Read-only by construction: same Owner gate, same reads, no transaction,
 * nothing written. The arithmetic is the same `plan_change_settlement` the
 * apply path calls, so this is a quote the commit cannot contradict — but
 * it is still a QUOTE, and {@link as_of} says when it was taken, because
 * proration depends on the clock and a preview left open in a tab drifts
 * from what will actually be charged (the apply prices itself again at its
 * own `now`).
 *
 * It refuses the same cases the apply refuses, so a preview never quotes a
 * price for a switch that would be rejected: no subscription for this
 * service (`billing.rs:1426-1430`), subscription not `active`
 * (`billing.rs:1437-1439`), already on this plan
 * (`billing.rs:1440-1442`) — all plain 400 `BadRequest`, no `code`.
 */
export interface PreviewChangePlanResult {
  service_id: string;
  from_plan: string;
  to_plan: string;
  /** `true` when the billing cadence changes (e.g. monthly → yearly),
   *  which RESETS the period boundary instead of keeping it. */
  cadence_change: boolean;
  /** What comes back on a downgrade, INTEGER MINOR UNITS; 0 otherwise. */
  refund_cents: number;
  /** What is owed on an upgrade, INTEGER MINOR UNITS; 0 otherwise. */
  due_cents: number;
  /** Where the period would end afterwards; `null` for open-ended. */
  new_period_end: number | null;
  /** The same SIGNED figure the apply path settles, for a caller that
   *  would rather do its own arithmetic: positive = debit, negative =
   *  credit. */
  net_cents: number;
  settlement: "debit" | "credit" | "none";
  /** ISO-4217 unit of every `*_cents` above. */
  currency: string;
  /** The app's prepaid balance right now, in CREDIT UNITS. */
  credit_balance: number;
  /**
   * ⚠ THE FIELD THAT TURNS A 402 INTO A DECISION. `changePlan()` can only
   * answer the "can I afford this?" question by REFUSING it (402
   * `insufficient_credits`); this answers it before anything is
   * committed. `false` ⇒ do not call `changePlan()`, top up first.
   * Computed as `net_cents <= 0 || credit_balance >= net_cents`, so a
   * downgrade or a no-op is always `true`.
   */
  sufficient_credit: boolean;
  /** When this quote was computed (epoch ms). Proration is a function of
   *  the clock — treat an old `as_of` as stale. */
  as_of: number;
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
  /** INTEGER MINOR UNITS. Pair with {@link currency}. */
  amount_cents: number;
  /**
   * ISO-4217 unit of `amount_cents` — always present, on the fresh path
   * and on an idempotent replay alike (the replay reads it off the stored
   * order). It is the Binance checkout currency when that connector is
   * configured, otherwise the platform currency — never a blank unit.
   */
  currency: string;
  provider: string;
  status: "pending";
  idempotent?: boolean;
  checkout_url?: string;
  qrcode_link?: string;
  qr_content?: string;
  prepay_id?: string;
  expire_time?: number;
}

// ============================================================
// Prepaid credits (a custodial virtual-token ledger — NOT currency)
// ============================================================

/** One buyable credit pack, from {@link BillingClient.creditsPacks}
 *  (`credits.rs:274-280`). */
export interface CreditPack {
  /** Pass this as {@link CreditsCheckoutInput.pack_id}. */
  id: number;
  /** Credits granted when the order settles. A VIRTUAL prepaid unit, NOT
   *  money. */
  credits: number;
  /** What the pack costs, INTEGER MINOR UNITS of
   *  {@link CreditsPacksResult.currency}. */
  price_cents: number;
  /** Start of the sale window (epoch ms). */
  valid_from: number;
  /** End of the sale window, or `null` for open-ended. */
  valid_to: number | null;
}

export interface CreditsPacksResult {
  /**
   * Packs buyable RIGHT NOW — `active` and inside their sale window —
   * cheapest first.
   *
   * ⚠ AN EMPTY LIST IS A REAL ANSWER, not an error and not a loading
   * state. No pack is seeded by default (`credits.rs:173-177`: what a
   * credit costs is a business decision, and a made-up default would be a
   * wrong price shipped quietly), so on a fresh deployment credits are
   * UNBUYABLE until an operator configures one. Say that on screen rather
   * than rendering a dead form.
   */
  packs: CreditPack[];
  /** ISO-4217 unit of every `price_cents` above, so a caller never has to
   *  guess it (`credits.rs:279`). */
  currency: string;
}

/**
 * ⚠ BREAKING (server-side, 2026-08-18): the buyer now chooses WHICH PACK
 * and nothing else.
 *
 * This used to carry `credit_amount`, `amount_cents` and `currency`, and
 * the handler stored all three as given — so the buyer set the price of
 * their own purchase, and the settlement check compared the money
 * collected against that same buyer-supplied figure (`credits.rs:92-98`).
 * Credits and price now both come from the `credit_packs` row.
 *
 * `pack_id` is REQUIRED and has NO serde default, deliberately
 * (`credits.rs:100-102`): a client still posting the old body must fail
 * outright rather than fall through to pack 0 or to its own price.
 *
 * HOW THAT FAILURE LOOKS — it is unlike any other error this SDK raises.
 * It happens in axum's `Json` extractor, BEFORE the handler and before
 * the platform's `{result, code}` envelope exists: a bare HTTP 422 with a
 * plain-text body. The transport's `res.json()` therefore throws, and
 * `http.ts:222-227` falls back to the status line, so the caller gets a
 * `BadRequestError` with `status: 422`, `code: "bad_request"` (a
 * placeholder from `errors.ts:58`, NOT a server code) and `msg` set to
 * the bare HTTP reason phrase. The server's actual explanation ("missing
 * field `pack_id`") is in the plain-text body and is discarded by the
 * envelope path — so do not expect a code to switch on here. Call
 * {@link BillingClient.creditsPacks} and send a real `pack_id`.
 */
export interface CreditsCheckoutInput {
  app_tid: string;
  /** Which {@link CreditPack} to buy. Credits AND price both come from
   *  that row — required, no default. */
  pack_id: number;
  provider?: string;
  /** Same key returns the existing order, never a duplicate charge. */
  idem_key?: string;
}

export interface CreditsCheckoutResult {
  order_ref: string;
  /** Credit units, snapshot from the pack onto the order — a later price
   *  edit cannot retro-change a placed order. */
  credit_amount: number;
  /** INTEGER MINOR UNITS, likewise snapshot from the pack. */
  amount_cents: number;
  /** The pack this order was placed against. */
  pack_id: number;
  /**
   * ISO-4217 unit `amount_cents` was recorded in (`credits.rs:221`).
   *
   * ⚠ OPTIONAL because of a real server asymmetry: the fresh path sends
   * it, the IDEMPOTENT-REPLAY branch does NOT (`credits.rs:138-148`
   * returns `order_ref`, `credit_amount`, `amount_cents`, `pack_id`,
   * `provider`, `status`, `idempotent` and no `currency`). Fall back to
   * {@link CreditsPacksResult.currency} when `idempotent` is `true`.
   */
  currency?: string;
  provider: string;
  status: "pending";
  idempotent?: boolean;
}

export interface CreditsBalance {
  /** In CREDIT UNITS (the same unit as `credit_amount` above) — NOT cents. */
  balance: number;
}

export interface CreditsLedgerInput {
  app_tid: string;
  /** Page backwards: return only entries OLDER than this id. */
  before_id?: number;
  /** Clamped server-side to 1..200; default 50 (`credits.rs:607`).
   *  Out-of-range values are silently clamped, not rejected. */
  limit?: number;
}

/** One movement on the prepaid-credit ledger. All amounts are CREDIT
 *  UNITS, never cents. */
export interface CreditsLedgerEntry {
  /** Monotonic id — pass the oldest one back as
   *  {@link CreditsLedgerInput.before_id} to page. */
  id: number;
  /** Signed: positive = credited, negative = debited. */
  delta: number;
  /** The WHY. NEVER `null` — an entry written without one is reported as
   *  the literal `"unknown"` (`credits.rs:632-633`), because `null` would
   *  render as "no reason". Seeing `"unknown"` is a server-side defect to
   *  chase, not a blank to render. */
  reason: string;
  /** What the movement was FOR — an `order_ref`, or the plan change that
   *  caused a proration. This is what makes a line checkable against the
   *  orders and invoices on the same screen. `null` when unattributed. */
  ref: string | null;
  /** The balance the ledger ASSERTED at the time of this movement,
   *  returned AS STORED and never recomputed on the way out
   *  (`credits.rs:578-581`) — recomputing would paper over exactly the
   *  drift a reconcile pass exists to detect. So this may legitimately
   *  disagree with a running total you compute from `delta`s, and the
   *  disagreement is the signal. */
  balance_after: number;
}

export interface CreditsLedgerResult {
  /** Newest first. */
  entries: CreditsLedgerEntry[];
  /** Whether another page exists, so a client never has to fetch one to
   *  discover it is empty. */
  has_more: boolean;
}

// ============================================================
// History + invoices
// ============================================================

/**
 * One row of `/billing/history`'s subscription list — which on this
 * platform is NOT necessarily a subscription.
 *
 * The server list is `app_services` FULL OUTER JOIN `subscriptions`
 * (`invoice.rs:1214-1230`): entitlement drives it, but the join is FULL
 * OUTER, not LEFT, so a billing screen cannot hide a row that exists. A
 * grant with no payment behind it is ordinary; a billing row whose grant
 * is gone is an anomaly worth SHOWING.
 *
 * ⚠ A GRANT IS NOT A SUBSCRIPTION, and on this platform most plans arrive
 * by grant. Check {@link source} before offering any billing action: a
 * client without it will offer "Cancel subscription" for a plan nobody
 * pays for (`invoice.rs:1246-1250` says so in as many words).
 *
 * ⚠ TWO PLANS, DELIBERATELY. {@link plan}/{@link status} are what the
 * server ENFORCES; {@link billing_plan}/{@link billing_status} are what
 * was CHARGED. They CAN disagree, and when they do the disagreement is
 * the most important thing on the screen: an app whose subscription says
 * `pro` while its grant says `demo` is being served demo, and the owner
 * is entitled to see both halves rather than one plausible number
 * (`invoice.rs:1258-1264`).
 */
export interface BillingSubscriptionSummary {
  service_id: string;
  /** The ENTITLEMENT — what the server actually enforces, however it
   *  arrived (grant or purchase). */
  plan: string;
  /** The ENTITLEMENT's status. */
  status: string;
  /** What the billing cycle says was purchased. `null` on a pure grant
   *  (no `subscriptions` row at all). */
  billing_plan: string | null;
  /** The billing row's own status. `null` on a pure grant. */
  billing_status: string | null;
  /**
   * Where this plan came from, read off the JOIN rather than guessed from
   * which optional fields happen to be populated — a subscription row
   * with no `provider_ref` and no period end is still a subscription.
   * `"grant"` ⇒ there is no billing relationship to cancel, change or
   * refund.
   */
  source: "subscription" | "grant";
  /** Period end, falling back to the GRANT's own `expires_at` when there
   *  is no billing row (`invoice.rs:1241-1245`) — reporting `null` there
   *  would read as "never expires", the opposite of the truth for a
   *  time-boxed grant. `null` means genuinely open-ended. */
  current_period_end: number | null;
  /** Who granted it, on a granted row. `null` for a purchase. */
  granted_by: string | null;
  provider: string | null;
  provider_ref: string | null;
  /** The billing row's `updated_at`, falling back to the grant's
   *  `granted_at`, or 0 if neither is set (`invoice.rs:1273-1275`). */
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
  /** `true` only for `email: "sent"`. */
  emailed: boolean;
  /**
   * The delivery outcome — the four HONEST NO-OPS only.
   *
   * `"send_failed"` used to be listed here and is deliberately gone: it
   * is no longer reachable as a RETURN value. It is the one outcome where
   * the platform tried to deliver and the attempt failed, so the server
   * now answers it with `result: false` + `code: "send_failed"`
   * (`invoice.rs:972-986`) instead of dressing a refusal as success — and
   * this SDK's transport throws on any `result: false` (`http.ts:254`).
   * See {@link BillingClient.invoiceEmail} for what that throw looks like.
   *
   * The other four keep `result: true` under the config-ready rule: no
   * mailer wired, the owner has no address, or the receipt already went
   * are all "nothing to do", not failures.
   */
  email: "sent" | "not_configured" | "no_owner_email" | "already_emailed";
  invoice_no: string;
}

// ============================================================
// Service catalog + token redemption (`/service/*`)
// ============================================================
//
// The entitlement side of the same service model `/billing/catalog`
// prices: what services exist, and redeeming a signed token into a grant.
// Distinct from the LEGACY `/license/redeem` further down — different
// table, different token, different codes.

/** One service, from {@link BillingClient.serviceList}
 *  (`entitlement_admin.rs:558-566`). */
export interface ServiceCatalogEntry {
  id: string;
  name: string;
  /** Which subject kinds this service accepts, e.g. `["app"]`,
   *  `["user"]`. Drives a service → plan → subject-kind cascade. */
  subject_kinds: string[];
  /** Plan names defined for this service, sorted. May be empty — a
   *  service with no plans yet is still listed (LEFT JOIN). */
  plans: string[];
}

/** The grant a redeemed entitlement token produced
 *  (`entitlement_admin.rs:341-342`). */
export interface ServiceRedeemResult {
  service_id: string;
  plan: string;
  /** `"app"` or `"user"` — taken from the TOKEN, never from the caller. */
  subject_type: string;
  /** The subject the grant landed on. */
  subject_id: string;
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
  /**
   * INTEGER MINOR UNITS — of an UNSTATED currency.
   *
   * ⚠ PLATFORM-SIDE GAP, not an SDK omission. `/licenses/catalog` emits
   * this bare integer with no unit anywhere in the response
   * (`license_catalog.rs:95` — no `currency`, no `minor_units`, no
   * sibling money block), which is precisely the defect the newer
   * `/billing/catalog` fixed by shipping {@link BillingMoney}. The legacy
   * route was not given the same treatment, so there is no unit here to
   * type and this SDK will not invent one.
   *
   * Do NOT assume 2 decimals and do NOT assume USD. If you must render
   * this, read {@link BillingClient.catalog}'s `money.currency` /
   * `money.minor_units` and format against those — with the caveat that
   * pairing them is an ASSUMPTION about a route that does not declare its
   * unit, not something the server told you. Prefer showing the legacy
   * tier's quota deltas without a price.
   */
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
   * period, feature bullets, resolved limits, self-service flag), plus the
   * {@link BillingMoney} block and the {@link PaymentProvider} menu. No
   * auth required — safe for an anonymous marketing/pricing page.
   *
   * Uses `HttpCore.get()`: the route is mounted **GET-only** server-side
   * (`billing.rs:49`: `.route("/billing/catalog", get(catalog))`).
   *
   * READ `money` BEFORE FORMATTING ANY PRICE — `price_cents` is pre-tax
   * and `minor_units` is not always 2. See {@link BillingMoney}.
   *
   * Throws rather than returning a half-catalog: this used to fall back to
   * `{services: []}` when the response was not JSON, which rendered as an
   * empty pricing page with no error anywhere. And a `money` block cannot
   * be defaulted — guessing `USD`/2-decimals is exactly the invented unit
   * the server-side fix removed, so a response without one is reported,
   * not patched over.
   */
  async catalog(): Promise<BillingCatalog> {
    const body = await this.http.get<BillingCatalog | undefined>("/billing/catalog");
    if (!body || !body.money) {
      throw new Error(
        "@tfl5/sdk: /billing/catalog returned no `money` block — refusing to " +
          "guess a currency or decimal count for the prices it quotes",
      );
    }
    return body;
  }

  // ---- Self-service account status / checkout / plan changes ------------

  /**
   * The authenticated caller's own app-creation quota + which USER-subject
   * plans they currently hold (drives the "✓ Current" marker on a pricing
   * card).
   *
   * ⚠ Read {@link BillingAccountStatus} before wiring a UI to this. Two
   * things there will otherwise be got wrong:
   *  - `user_max_apps` is NOT the enforced cap on most accounts; the
   *    enforced pair is `model` + `effective_cap`.
   *  - `current_subscriptions` is the only warning a client gets before
   *    an account-plan "Buy" charges full price and forfeits the
   *    remainder of a plan the user already holds. There is no
   *    user-subject proration path — see {@link changePlan}.
   */
  account(): Promise<BillingAccountStatus> {
    return this.http.post<BillingAccountStatus>("/billing/account");
  }

  /**
   * Create a pending order for a (service, plan) — either an app-subject
   * purchase (default; caller must be Owner of `app_tid`) or a user-subject
   * purchase for the caller themselves (requires a verified email either
   * way). Returns an `order_ref`; a paid settlement (via the dark webhook)
   * activates the grant. Idempotent on `idem_key`.
   *
   * ⚠ THIS IS NOT A PLAN CHANGE, even when the caller already holds the
   * service. It does not check for an existing subscription, and the
   * settlement upserts the row — so it charges FULL price, RESETS the
   * period and FORFEITS whatever was left of the plan being replaced
   * (`billing.rs:485-491`). For an APP subject use {@link changePlan} /
   * {@link previewChangePlan} instead, which prorate. For a USER subject
   * there is no prorating alternative (see {@link changePlan}); check
   * `account().current_subscriptions` and warn before the click.
   */
  checkout(input: CheckoutInput): Promise<CheckoutResult> {
    return this.http.post<CheckoutResult>("/billing/checkout", input);
  }

  /**
   * QUOTE a mid-period plan switch without committing anything: what
   * comes back, what is due, when the period would end, and — the field
   * that matters most — whether the prepaid balance actually covers it.
   *
   * Read-only (no transaction, nothing written) and Owner-gated on
   * `app_tid` (`billing.rs:1413`), taking the SAME request as
   * {@link changePlan}. It uses the same settlement arithmetic as the
   * apply path and makes the same refusals, so a quote it returns is one
   * the apply will honour — modulo the clock, which is why the result
   * carries `as_of`.
   *
   * Call this FIRST and check `sufficient_credit`: it is how a client
   * learns an upgrade is unaffordable before committing, instead of from
   * a 402 `insufficient_credits` rejection.
   */
  previewChangePlan(input: ChangePlanInput): Promise<PreviewChangePlanResult> {
    return this.http.post<PreviewChangePlanResult>(
      "/billing/subscription/preview-change",
      input,
    );
  }

  /**
   * Switch an app-subject subscription to a different plan mid-period.
   * The prorated difference settles through the prepaid-credit ledger in
   * the SAME transaction as the plan flip (atomic): an upgrade debits the
   * difference, a downgrade credits it back.
   *
   * Prefer {@link previewChangePlan} first — it answers "can this
   * customer afford it?" as data rather than as a rejection.
   *
   * ⚠ APP SUBJECTS ONLY. `subject_type` is hardcoded `"app"` here
   * (`billing.rs:1537`) and in the preview (`billing.rs:1419`), both
   * behind an app-Owner gate, so THERE IS NO USER-SUBJECT PRORATION DOOR.
   * Changing an ACCOUNT plan has to go through {@link checkout}, which
   * charges full price and resets the period — see its warning.
   *
   * Throws `code: "insufficient_credits"` (402) if the credit balance
   * can't cover an upgrade's debit — nothing flips in that case. Throws
   * `code: "conflict"` (400) if the subscription/plan changed concurrently
   * between read and write (lost a race — safe to retry). Both statuses
   * are operator-revertible by different switches, so match on `code`; see
   * this file's header REFUSALS note.
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
   * The credit packs a customer may buy RIGHT NOW, plus the currency
   * their prices are in. Signed-in only — no app scope, no request body
   * (`credits.rs:69`, gate at `credits.rs:244`).
   *
   * Call this before {@link creditsCheckout}: `pack_id` is the only thing
   * a buyer now chooses, and there is no other way to learn a valid one.
   * The pack list is filtered by the same `active` + sale-window
   * predicate the checkout gate applies (`credits.rs:250-255` vs
   * `:162-165`), so the list is exactly the set checkout will accept — a
   * screen here cannot offer a pack the server then refuses.
   *
   * ⚠ AN EMPTY `packs` ARRAY IS A REAL ANSWER: no pack is seeded by
   * default, so credits are unbuyable until an operator configures one.
   * See {@link CreditsPacksResult.packs}.
   */
  creditsPacks(): Promise<CreditsPacksResult> {
    return this.http.post<CreditsPacksResult>("/billing/credits/packs");
  }

  /**
   * Create a pending order to top up an app's prepaid credit balance.
   * Owner-gated (app-subject only — no user wallet yet). Idempotent on
   * `idem_key`, scoped per-app.
   *
   * ⚠ TAKES `pack_id` NOW, and nothing else about the price. The old
   * `{credit_amount, amount_cents, currency}` body let the buyer set
   * their own price and no longer deserializes at all — a client still
   * sending it gets a bare HTTP 422 that carries none of the platform's
   * `{result, code}` envelope, so it will not look like any other error
   * this SDK raises. {@link CreditsCheckoutInput} documents exactly what
   * the caller sees.
   *
   * Throws `code: "pack_not_buyable"` (400) when the pack is unknown,
   * inactive or outside its sale window — re-checked server-side
   * regardless of what the UI is showing, and also what a platform with
   * NO packs configured answers (`credits.rs:173-181`).
   */
  creditsCheckout(input: CreditsCheckoutInput): Promise<CreditsCheckoutResult> {
    return this.http.post<CreditsCheckoutResult>("/billing/credits/checkout", input);
  }

  /** The app's current prepaid credit balance (0 if none yet). Owner-gated. */
  creditsBalance(appTid: string): Promise<CreditsBalance> {
    return this.http.post<CreditsBalance>("/billing/credits/balance", { app_tid: appTid });
  }

  /**
   * The movement history behind {@link creditsBalance} — newest first,
   * paged backwards with `before_id`.
   *
   * Owner-gated on `app_tid` (`credits.rs:603`): a movement history is at
   * least as sensitive as the total it adds up to. `limit` is clamped
   * server-side to 1..200 (default 50), so an out-of-range value is
   * silently adjusted rather than rejected — don't rely on your own
   * number coming back.
   *
   * Every amount here is in CREDIT UNITS, not cents.
   */
  creditsLedger(input: CreditsLedgerInput): Promise<CreditsLedgerResult> {
    return this.http.post<CreditsLedgerResult>("/billing/credits/ledger", input);
  }

  // ---- History + invoices ------------------------------------------------

  /**
   * A snapshot for the app's billing page: active subscriptions, the
   * credit balance, the most-recent 20 paid orders per purchase model, and
   * the most-recent 20 invoices. Owner (author) only — Managers of the app
   * cannot call this, or any other `/billing/invoice/*` / `/billing/history`
   * endpoint (all Owner-gated).
   *
   * ⚠ `subscriptions` here IS NOT A LIST OF SUBSCRIPTIONS. It is an
   * entitlement ⋈ billing FULL OUTER JOIN, and on this platform most
   * plans arrive as GRANTS with no billing row behind them. Branch on
   * each row's `source` before offering any billing action, and expect
   * `plan` (enforced) and `billing_plan` (charged) to disagree. See
   * {@link BillingSubscriptionSummary}.
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
   *
   * ⚠ A GENUINE SEND FAILURE THROWS, it does not resolve. When the mailer
   * refuses the message the server answers `result: false` +
   * `code: "send_failed"` (`invoice.rs:972-986`), and this SDK's
   * transport throws on any `result: false` (`http.ts:254`) — so
   * `"send_failed"` is NOT a reachable value of the resolved
   * {@link InvoiceEmailResult.email} and is no longer in its type.
   *
   * That throw arrives as a `BadRequestError` with `code: "send_failed"`
   * and `status: 200` (the handler answers `Ok(Json(...))`, so the HTTP
   * status stays 200 while the envelope says false — this is the ONE
   * refusal in this file that did not move off 200). Its `msg` is the
   * sentence both platform consoles print. Catch it if a failed receipt
   * should not fail the surrounding flow: the invoice itself is already
   * issued and unaffected, and the server RELEASES its emailed-at mark on
   * a send failure, so a straight retry works.
   *
   * A resolved result therefore always means "nothing went wrong", though
   * only `email: "sent"` means a message actually left.
   */
  invoiceEmail(input: InvoiceEmailInput): Promise<InvoiceEmailResult> {
    return this.http.post<InvoiceEmailResult>("/billing/invoice/email", input);
  }

  // ---- Service catalog + token redemption (`/service/*`) -----------------

  /**
   * The service catalog as the entitlement side sees it: id, name,
   * accepted subject kinds and defined plan names
   * (`entitlement_admin.rs:37`, handler `:538`). Signed-in; the catalog
   * is not a secret (it is shown next to pricing), it just isn't
   * anonymous like {@link catalog}.
   *
   * Use it to drive a service → plan → subject-kind cascade.
   * {@link catalog} is the PRICED view of the same services and carries
   * no `subject_kinds`-per-plan cascade; this one carries no money.
   */
  serviceList(): Promise<ServiceCatalogEntry[]> {
    return this.http.post<ServiceCatalogEntry[]>("/service/list");
  }

  /**
   * Redeem a signed ENTITLEMENT token into an active service grant
   * (`entitlement_admin.rs:38`, handler `:202`). Distinct from
   * {@link redeemLicenseToken}, which redeems the LEGACY per-tier license
   * token — different table, different token, different codes.
   *
   * The subject comes from the TOKEN, never from the caller: a
   * user-subject token redeems only for the caller, and an app-subject
   * token requires the caller to be Owner of that app. On success the
   * grant is upserted `active` with its expiry cleared.
   *
   * Throws (all HTTP 200 with `result:false`; `.code` distinguishes):
   * `entitlement_token_not_configured` (feature off on this cell),
   * `entitlement_token_invalid` (bad signature/claims),
   * `entitlement_token_subject_mismatch` (minted for another account),
   * `entitlement_subject_unsupported` (org-subject not enabled yet),
   * `entitlement_plan_unknown` (token names a (service, plan) that does
   * not exist), `entitlement_token_unusable` (unknown, already redeemed,
   * revoked, or a lost concurrent redeem). A missing session throws
   * `UnauthorizedError` — the handler answers `{isSignout:true}` and the
   * transport converts it (`http.ts:241-243`).
   */
  serviceRedeem(token: string): Promise<ServiceRedeemResult> {
    return this.http.post<ServiceRedeemResult>("/service/redeem", { token });
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
   *
   * Match on `.code`, never on `.msg`. `license_token_not_configured`'s
   * message was rewritten to a customer-safe sentence in
   * `license.rs:894-899` — it used to name a server path and an env var,
   * telling an ordinary customer how the host is laid out; the operator
   * detail now goes to the log instead. The machine `code` did not
   * change, so a code-keyed classifier was unaffected and a prose-keyed
   * one broke. Every `msg` in this list is subject to the same rewording
   * (and to VI⇄EN localization) without notice.
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
