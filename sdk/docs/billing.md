# Billing

`tfl5.billing` covers what the platform sells to app owners: plans for
services, app-creation rights, prepaid credits, invoices, and entitlement
tokens handed out by the platform operator.

**Money** is always an integer in the currency's smallest unit (`*_cents`).
Format it with the `currency` and `minor_units` returned alongside it — some
currencies (VND, JPY) have no decimal places.

## What is for sale

```ts
const catalog = await tfl5.billing.catalog();     // public, no sign-in needed
// catalog.services[].plans[] → { plan, display_name, price_cents, total_cents, billing_period, … }
// catalog.money → { currency, minor_units, vat_rate_bps, prices_include_vat }

const me = await tfl5.billing.account();          // apps_used, remaining, current_plans, …
```

## Buying

Checkout creates a pending order. Payment is confirmed asynchronously by the
payment provider; for hosted providers the order carries a `checkout_url` or
a QR payload to show the buyer. Pass an `idemKey` so a retried request does
not create a second order.

```ts
// a plan for the scoped app (you must own it)
const order = await tfl5.billing.checkout({ serviceId: "storage", plan: "pro", idemKey });

// rights to create more apps, for yourself (verified email needed)
const packs = await tfl5.billing.appRightsPacks();
await tfl5.billing.appRightsCheckout({ packId: packs.packs[0].id, idemKey });
```

### Changing plan

```ts
const quote = await tfl5.billing.previewPlanChange({ serviceId: "storage", plan: "business" });
// quote.net_cents, quote.settlement ("debit" | "credit" | "none"), quote.sufficient_credit
await tfl5.billing.changePlan({ serviceId: "storage", plan: "business" });
```

The difference is settled against the app's prepaid credits in the same
transaction. `changePlan` is refused with `insufficient_credits` when an
upgrade costs more than the balance.

## Prepaid credits

```ts
await tfl5.billing.credits.packs();                              // packs on sale
await tfl5.billing.credits.checkout({ packId, idemKey });        // Owner of the scoped app
const balance = await tfl5.billing.credits.balance();
const page = await tfl5.billing.credits.ledger({ limit: 50 });  // append-only history
```

## Invoices

```ts
const inv = await tfl5.billing.invoices.issue({ orderRef: order.order_ref });  // idempotent
const pdf = await tfl5.billing.invoices.pdf({ invoiceNo: inv.invoice_no });   // Blob
await tfl5.billing.invoices.email({ invoiceNo: inv.invoice_no });             // to the app owner
const history = await tfl5.billing.history();                                // subscriptions, orders, invoices
```

Invoices are for paid orders of the scoped app and need the Owner.

## Entitlement tokens

The platform operator can grant a plan with a signed, single-use token:

```ts
await tfl5.billing.services();          // what tokens can grant
await tfl5.billing.redeem(token);       // → { service_id, plan, subject_type, subject_id }
```

A user token applies to the caller; an app token needs the caller to own that
app.

## Account tiers (`tfl5.license`)

`tfl5.license` reads the base account/app tier (how many apps, how much
storage) and files upgrade requests with the operator:

```ts
await tfl5.license.get();               // current tier, usage, headroom
await tfl5.license.catalog();           // tiers
await tfl5.license.previewUpgrade("user", "pro");
await tfl5.license.requestUpgrade("app", "pro", "we need more storage");
```

`license.redeem()` redeems the older license tokens; new grants use
`billing.redeem()`.
