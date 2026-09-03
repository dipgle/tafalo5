# tfl5 API Reference

> Companion to [app-builder-guide.md](./app-builder-guide.md) (concepts),
> [acl-model.md](./acl-model.md) (authorization) and
> [security-model.md](./security-model.md) (trust boundaries). Endpoint
> reference for app developers + AI agents consuming tfl5 via REST.

## How to read this document

The API is **stable by contract**: the route surface is fixed, and only the
tfl5 platform adds routes to it. Your app never defines its own HTTP routes —
it composes behaviour out of the endpoints below (plus tenant-authored code
that runs *inside* them: schema validators, JS hooks, WASM operators). Routes
are added over time; existing request/response fields are additive.

Endpoints fall into four groups, and this document keeps them apart:

| Group | Who calls it | Marker |
|---|---|---|
| **App-developer API** | your app / your users, with a session cookie or a service token | the bulk of this document |
| **Platform-operator API** | whoever runs the tfl5 cell | [§ Platform-operator endpoints](#platform-operator-endpoints-admin) — `/admin/*`, platform-admin gate |
| **Flag-gated subsystems** | only where an operator switched them on | flagged inline with the env var; see also [security-model.md §10](security-model.md) |
| **Unauthenticated surfaces** | browsers, webhooks, health probes | auth line says *Anonymous* |

Do not assume a flag-gated subsystem is live just because its endpoints are
documented here. Ask your operator.

## Conventions

- **Transport:** HTTPS, bodies `application/json` unless the endpoint is
  marked *multipart*.
- **HTTP method:** POST for every endpoint except the GETs flagged inline
  (`/healthz`, `/livez`, `/metrics`, `/platform/info`, `/platform/version`,
  `/billing/catalog`, `/auth/magic`, `/auth/vneid/callback`, `/auth/sso`,
  `/_sso/accept`, `/_signed/:token`, `/verify-email`, `/app/site/preview`,
  `/public/:app_tid/:resource_ma/:public_code`, `/sdk.js`, `/sdk.mjs`,
  `/sdk-ui.js`, `/sdk-ui.mjs`, `/_tfl5/vendor/:file`, `/ws/chat`,
  `/ws/durable/subscribe`).
- **Identifiers (`tid`)** are prefixed, hyphenated UUIDs: `u-…` users,
  `a-…` apps, `r-…` resources *and* roles, `d-…` docs and file rows,
  `g-…` groups, `sh-…` shares, `iv-…` invites, `src-…` signed sources,
  `bv-…`/`bf-…` bundle versions/files, `lr-…` license requests,
  `u-svc-…` service principals. Legacy rows created before the platform
  standardised on `-` may still carry `u_<uuid>`; the ACL layer
  canonicalises both forms to the same identity, so compare canonically
  rather than by string prefix.
- **Session:** cookie `_token` (name configurable server-side via
  `TFL5_COOKIE_NAME`). Issued by `/login`, `/auth/google`,
  `/auth/microsoft`, `/auth/magic`, `/auth/qr/poll`,
  `/auth/telegram/login`, `/auth/phone/verify`, `/auth/vneid/callback`,
  `/_sso/accept`. Cleared by `/logout`.
- **Service token (server-to-server):** `Authorization: Bearer <token>` is
  tried **before** the cookie. The token must carry the platform's service
  token prefix (`st_` by default) and match a live `service_tokens` row;
  revoked/expired tokens fall through to anonymous rather than erroring.
  Tokens are minted by the operator (`/admin/token/mint`) and act **as the
  subject user** — same ACL, no extra powers. A bearer token that isn't a
  tfl5 service token (e.g. someone else's JWT) is ignored, not rejected.
  A token may additionally be **scoped to a set of request paths** —
  see [Service-token scopes](#service-token-scopes).
- **Success envelope:**
  ```json
  { "result": true, "data": <object|array>, "timestamp": 1700000000000 }
  ```
  Some endpoints put their payload in a named key instead of `data`
  (`/login` → `user`, `/app/site/list` → `entries`, `/app/chat/history` →
  `messages`, …). The per-endpoint sections below give the real key.
- **Error envelope:** always carries `code`; match on `code`, never on
  `msg` (messages are reworded and localised).
  ```json
  { "result": false, "msg": "...", "code": "<code>", "timestamp": ... }
  ```
- **HTTP status is meaningful again.** Older tfl5 releases returned HTTP
  200 for validation failures; current builds do not:

  | Condition | Status | Body |
  |---|---|---|
  | Bad request (generic or coded) | **400** | `{result:false, msg, code}` |
  | Not signed in / expired session | **401** | `{isSignout:true, result:true, code:"unauthorized"}` |
  | Signed in but not permitted | **200** | `{result:false, msg:"Access denied", code:"access_denied"}` |
  | Not found | **200** | `{result:false, msg:"not found", code:"not_found"}` |
  | Refused — a quota is spent | **402** | `{result:false, msg, code}` (+ `data`) |
  | Refused — conflicts with current state | **409** | `{result:false, msg, code}` (+ `data`) |
  | Refused — payload over a cap | **413** | `{result:false, msg, code}` (+ `data`) |
  | Rate limited | **429** | `{result:false, code:"rate_limit_exceeded"}` + `Retry-After` |
  | Server error | **500** | `{result:false, msg:"internal error", code:"internal"}` — the real cause is never echoed |

  Operator escape hatches restore the legacy behaviour during a migration
  window, but **each covers exactly one mechanism** —
  `TFL5_LEGACY_BADREQUEST_200=1` (the 400 class → 200),
  `TFL5_LEGACY_UNAUTHORIZED_200=1` (401 → 200) and
  `TFL5_LEGACY_REFUSAL_200=1` (the 402/409/413 refusal class → 200) — and
  some statuses no flag can move (see below). Because of all this, and
  because `access_denied` / `not_found` are 200 by design, a correct
  client checks `result` + `code` **and** the status — not the status
  alone.
- **Business refusals: the status is now per-refusal, and you may not
  hard-code it.** Older releases answered HTTP 200 for every
  business-rule failure. A refusal now carries a status chosen at the
  refusal site, because the three answers mean different things to a
  client deciding whether to retry, to pay, or to give up: **402** when a
  quota is spent, **409** when the request conflicts with a state the
  caller must change first, **413** when a payload is over a cap.

  The **envelope is unchanged**: `{result:false, msg, code, timestamp}`,
  plus a `data` object *only* at sites that have numbers to report (cap,
  used, remaining). Where a refusal has no numbers, `data` stays
  **absent** — it is never emitted as `"data": null`, so a `code`-based
  classifier written against the old 200s keeps working untouched.

  **There is no single "refusal" switch, because there is no single
  refusal mechanism.** Three separate ones produce non-200 rejections, and
  they revert differently:

  | Mechanism | Status | Reverts with | Example codes |
  |---|---|---|---|
  | per-site refusal | 402 / 409 / 413 | `TFL5_LEGACY_REFUSAL_200=1` | `quota_exceeded`, `owner_protected`, `resource_not_deleted`, `domain_quota_reached` |
  | coded bad request | 400 | `TFL5_LEGACY_BADREQUEST_200=1` | `conflict`, `pack_not_buyable`, `file_too_large` (write side) |
  | metered-credit refusal | 402 | **nothing — cannot be reverted** | `insufficient_credits` |

  The third row is not an oversight: a metered handler that needs an exact
  402 builds the response itself rather than routing through the shared
  error type, which has no 402 variant of its own. Two consequences a
  client must handle: the flag your operator set will **not** flatten it,
  and its envelope carries **no `timestamp`** — it is
  `{result:false, msg, code}` and nothing else, the one refusal shape in
  this document missing that field.

  Two more things follow, and both bite:
  - **ACL denials did not move.** `access_denied` is still HTTP 200, by
    design. A client that tests `res.ok` alone still reads "success" on
    every permission failure. That check has never been sufficient and
    still is not.
  - **The conversion is per-site, not universal.** Plenty of business
    refusals remain handler-authored 200 envelopes — `folder_not_empty`,
    `acl_token_unknown`, `user_not_found`, `acl_array_too_large`,
    `draft_disk_missing`, `share_not_found` and others. Treat the status
    as informative and the pair (`result`, `code`) as authoritative; the
    per-endpoint sections and the [error-code table](#error-codes) give
    the real status for each code.

  Sizes in refusal messages are rendered from binary values with decimal
  labels — 52,428,800 B prints as `50.0MB`. Compare the byte counts in
  `data`, never the words in `msg`.
- **Rate limits** (per cell, operator-tunable):
  `/login`, `/reg`, `/auth/*`, `/user/2fa/*` → 10 req/min per IP
  (`TFL5_RATE_AUTH_PER_MIN`); `/app/doc/*`, `/app/file/upload`,
  `/app/file/save` → 500 req/min **per tenant**
  (`TFL5_RATE_WRITE_PER_MIN`); everything else → 600 req/min per IP
  (`TFL5_RATE_GENERAL_PER_MIN`). `/healthz` and `/metrics` bypass the
  limiter. Rejection is 429 + `Retry-After`.
- **Permission tags:** Anonymous / Authenticated / Reader / Editor /
  Designer / Manager / Owner / platform-admin / per-doc ACL. Union
  semantics — see [acl-model.md](./acl-model.md). Owner = `apps.author`
  only; Manager = Owner ∪ `managers[]`; Designer = Manager ∪
  `designers[]`; Editor = Designer ∪ `editors[]`; Reader = Editor ∪
  `readers[]`.
- **`noaccess[]` vetoes at every level — except the app `author`.** The
  author short-circuits every check, so ownership stays an unrescindable
  recovery path. The same bypass applies to per-doc ACL for the app
  owner/managers and for a doc's own author.
- **Signout envelope — three shapes, and `result` lies in two of
  them.** Most handlers answer **401** +
  `{"isSignout": true, "result": true, "code": "unauthorized"}`. A few
  wire-compat handlers — `/user`, `/app/list`, and `/app/update`'s create
  branch — instead answer **HTTP 200** with a bare
  `{"isSignout": true, "result": true}` and no `code`. The
  [`/service/*`](#service-entitlements) pair answers **HTTP 200** with
  `{"isSignout": true, "result": false}`.

  Note what that first shape does: **`result` is `true` on a request
  that was refused for having no session.** A client branching on
  `result` alone reads "you are not logged in" as success, and the same
  client reads the `/service/*` variant as failure — two opposite
  conclusions from the same condition. The field is not a verdict on the
  request here; it is a legacy transport flag.

  **Treat `isSignout` as the signal** — check it before `result` and
  before the status, on every response.
- **Email-verification gate — owner-only.** Write-class levels (Manager /
  Designer / Editor) additionally require `users.email_verified = TRUE`
  **only when the caller is the app's own author**. A user who reached
  write-class through an explicit ACL grant is exempt — the owner already
  vouched for them. Reader is always exempt, and accounts with no email on
  record at all (phone-OTP, VNeID) are exempt because there is no inbox to
  verify. Creating a *new* app is gated separately and does require a
  verified email. Failure code: `email_not_verified`.
- **CORS:** `TFL5_CORS_ALLOW_ORIGINS` whitelist gates credentialed
  cross-origin calls; absent → permissive but **non**-credentialed (cookies
  are not sent). Allowed request headers include `Authorization`,
  `Content-Type`, `Cookie`, `id_app`, `x-tfl5-sdk-version`,
  `x-share-token`.

---

## Service-token scopes

A service token may carry a `scopes` list that restricts **which request
paths it may reach**. The restriction is enforced by middleware in front
of the handlers, so it applies before any ACL check and independently of
what the subject user is allowed to do. Scopes only narrow a token; they
can never grant it something its subject lacks.

**A scope is a request path prefix, matched on segment boundaries, or
the literal `*`.**

| Scope | Permits | Refuses |
|---|---|---|
| `/app/bundle` | `/app/bundle`, `/app/bundle/upload`, `/app/bundle/activate` | `/app/bundlefoo`, `/app/bundle-admin/wipe` |
| `/app/bundle/` | identical — a trailing slash is ignored | — |
| `*` | everything | nothing |
| `""` (blank entry) | nothing | everything |

The boundary rule is the point: a prefix match alone would let
`/app/bundle` reach `/app/bundle-admin/wipe`. Matching requires the next
character to be `/`, or an exact equality.

### Two grandfather clauses, both load-bearing

**1. An empty `scopes` list means unrestricted.** The column defaults to
an empty array, so *every token minted before scopes existed* carries
`{}` and is unaffected. Enforcement is opt-in by minting, never
retroactive.

**2. A scope the gate cannot evaluate does not restrict.** Only entries
equal to `*` or beginning with `/` are evaluated. A token whose scopes
are all dot-named labels — `["app.list"]`, `["user.read"]` — has nothing
evaluable in it and is therefore treated as **unscoped**, with a warning
logged server-side. This is the trap worth stating plainly: a label list
*looks* like a restriction and is not one.

**A mixed list is enforced against the evaluable half only.** Given
`["app.list", "/app/bundle"]`, the path scope is enforced and the legacy
label neither widens it back nor matches anything itself — `app.list`
does not match `/app/list`. So adding a path scope beside your old
labels does tighten the token; it does not leave a hole.

### Refusals

| Code | Status | When |
|---|---|---|
| `token_scope_denied` | **403** | the request path is outside the token's evaluable scopes. `data: {path, scopes}` |
| `token_scope_unavailable` | **503** | the gate could not read the token's scopes — fail-closed, retry |

`data.scopes` is the **full** stored list, including any unevaluable
legacy labels, while `msg` names only the evaluable subset — so the two
can legitimately differ in length.

The 503 fires only when a bearer token with the service-token prefix is
present *and* the scope lookup itself errors (a database problem). An
**unknown** token does not produce it: the gate falls through to the
normal anonymous path, deliberately, so it cannot be used to
distinguish "no such token" from "wrong scope".

### What the gate does not cover

The middleware wraps the main application router, not every route on the
process. These are reachable by a scoped token regardless of its
scopes: `/healthz`, `/livez`, `/metrics`, `/security/csp-report`,
`/ws/chat`, `/ws/durable/subscribe`, the public asset routes, and the
cluster-lifecycle operator routes `/admin/cell/drain`,
`/admin/cell/resume` and `/admin/version/apply`. Scopes are a blast-radius
control for the application API; they are not a substitute for the
platform-admin gate or for mTLS on the lifecycle routes.

The gate also matches on the token hash alone — expiry and revocation
are enforced on the authentication path, not here.

### Minting (`/admin/token/mint`)

Platform-admin only. **Body:** `{admin_app_tid, user_tid, name,
scopes?, ttl_days?}`. `name` is capped at **200 bytes** (bytes, not
characters — a Vietnamese or emoji name reaches the cap sooner than its
length suggests). `ttl_days` must be positive; omitted or non-positive
means no expiry.

**Response `data`:** `{tid, token, name, scopes, scopes_enforced,
scope_note, user_tid, expires_at, created_at}`. `token` is the plaintext
and is shown **once** — only its hash is stored.

**`scopes_enforced` and `scope_note` exist so a caller learns in-band
whether their scopes took effect**, rather than discovering months later
that a token they believed was restricted never was. There are three
outcomes:

| `scopes` you sent | `scopes_enforced` | Meaning |
|---|---|---|
| empty | `false` | unrestricted: the token can do everything its subject can |
| non-empty, but no entry is `*` or starts with `/` | `false` | **not enforced** — as written, this token is unrestricted |
| at least one `*` or `/…` entry | `true` | refused on any path outside its scopes |

Read `scopes_enforced` at mint time and fail your provisioning if it is
false when you meant to restrict.

**Revoking is not idempotent in its reply.** `/admin/token/revoke`
answers HTTP 200 `{result:false, msg:"Token not found or already
revoked"}` with **no `code` field** when the tid is unknown *or* already
revoked — the two are deliberately indistinguishable. Do not treat the
missing `code` as a malformed response, and do not retry on it. Success
is `data: {tid, revoked_at}`.

`/admin/token/list` returns unrevoked tokens only (cap 500) as
`{tid, user_tid, name, scopes, created_by, created_at, expires_at,
last_used_at}` — the plaintext token never appears again.

---

## Authentication

### POST /reg

**Auth:** Anonymous.

**Body:**
```json
{
  "username":        "string",  // required
  "password":        "string",  // required, >= 6 chars
  "re_password":     "string",  // required, must match password
  "email":           "string",  // required, plausible address (see below)
  "mobile":          "string",  // optional
  "name":            "string",  // optional
  "turnstile_token": "string"   // required IFF TFL5_TURNSTILE_SECRET set
}
```

**Response (success):**
```json
{ "result": true, "data": { "tid": "u-...", "username": "..." },
  "timestamp": 1700000000000 }
```

**Notes:**
- All validation failures return HTTP 200 with `msg` + `code` in
  (`validation_invalid`, `validation_password_short`,
  `validation_username_taken`, `validation_email_taken`).
- `email` must be a *plausible* address: exactly one `@`, non-empty
  local part, no whitespace, ≤ 254 chars, and a domain with at least two
  non-empty dot-separated labels. (`/auth/email-link` is looser — it only
  requires an `@` and ≤ 320 chars.)
- PII (email/name/mobile) is encrypted at rest; lookup is by SHA-256
  hash of the address.
- `validation_password_short` is returned as HTTP 400; the other
  `/reg` validation codes are HTTP 200 envelopes.
- First successful registration on a fresh cell promotes the user to
  Manager of `tfl5-admin` (bootstrap).
- Fires `auth.register` audit + best-effort verification email.

### POST /login

**Auth:** Anonymous.

**Body:**
```json
{ "username": "string", "password": "string" }
```

**Response (success):** sets `_token` cookie.
```json
{ "result": true, "user": { "tid": "u-...", "username": "..." },
  "timestamp": ... }
```

**Response (failure):** opaque (no user enumeration).
```json
{ "result": false, "msg": "Invalid username or password.",
  "code": "auth_invalid_credentials", "timestamp": ... }
```

**Username matching folds case and Vietnamese diacritics.** `/reg`
stores the *folded* form of whatever username was typed, so someone who
registered as `rdA_x` is stored as `rda_x` — and signing in as `rdA_x`
used to fail. Login now matches the raw string **or** the folded form,
preferring an exact raw match when both exist (rows written before the
folding existed may hold usernames that no longer round-trip).

The folding is Vietnamese-specific, not general Unicode normalisation:
it maps the precomposed Vietnamese vowel families to their base letters
and `đ`/`Đ` to `d`/`D`, strips a fixed set of punctuation
(`! % ^ * ( ) + = < > ? / , : ; ' " & # [ ] ~ $` — `@`, `.`, `_` and
`-` survive), turns whitespace runs and edge dashes into `_`, then
lower-cases. Accents outside that table (`ü`, `ñ`, Cyrillic, …) pass
through untouched. Envelope and error codes are unchanged.

**Notes:** legacy SHA-256 hashes silently rehash to argon2id on
successful login. Fires `auth.login.success` / `auth.login.fail`
audit rows.

### POST /logout

**Auth:** Anonymous (idempotent). Clears `_token` cookie (both
host-scoped and Domain-scoped variants). Returns `{ "result": true }`.

### POST /auth/email-link

**Auth:** Anonymous. Magic-link request.

**Body:**
```json
{ "email": "string", "redirect_to": "/path or #frag" }
```

**Response:** always the same opaque success message regardless of
whether email exists (anti-enumeration).

**Notes:**
- TTL 15 min; max 3 outstanding tokens per email.
- 32-byte random token; only SHA-256 hash stored.
- Best-effort email; failure does not change response.

### GET /auth/magic?token=...

**Auth:** Anonymous.

Consumes a magic-link token, sets `_token` cookie, redirects to the
sanitised `redirect_to` (or `/#/apps`). Returns an HTML interstitial
(`text/html`). First-time email → auto-creates `users` row with
placeholder username `user_<8hex>`, `email_verified = TRUE`,
`auth_methods = ['magic']`.

### POST /auth/google

**Auth:** Anonymous. Google Sign-In with One Tap / button.

**Body:**
```json
{
  "credential": "<google-id-token JWT>",   // required
  "password":   "string"                   // required only when linking
                                           // to an existing unverified
                                           // local account
}
```

An optional `app_tid` field may also be sent: when it names an app that
configured its own Google OAuth client, the token's audience is verified
against **that app's** client id instead of the platform-global one, so
an app can use its own consent screen. `GET /platform/info?app_tid=…`
returns the matching client id for rendering the button.

**Response:** sets `_token` cookie on success.
- New email → creates user (`auth_methods=['google']`, verified).
- Verified existing account with same email → auto-link.
- Unverified existing account → demands `password` to prove ownership.
  Without it: `{ "requires_password": true, "username_hint": "..." }`.

### POST /auth/microsoft

**Auth:** Anonymous. Microsoft (MSAL) sign-in — same shape and same
link-decision policy as `/auth/google`.

**Body:** `{ "credential": "<MSAL id token>", "password"?: "...",
"app_tid"?: "a-xxx" }`.

**Verification:** RS256 against Microsoft's published keys (cached 6 h),
audience pinned to the resolved client id (per-app when `app_tid` names
an app with its own, otherwise the platform-global one), issuer checked
against the token's own tenant.

**Email trust:** work/school (organisational directory) accounts are
trusted. Personal Microsoft accounts are trusted only when the token
carries the "email domain owner verified" claim — otherwise the flow
falls back to `requires_password` even for an already-verified local
account.

**Response:** sets `_token` cookie; `{result:true, user:{tid, username}}`.
Link-required replies carry `requires_password: true` and
`username_hint` rather than a `code`.

Note: `/user/link` with `provider: "microsoft"` is stricter — it refuses
an untrusted email outright instead of offering the password fallback.

**Notes:** verifies via cached Google JWKS (6-hour cache).

### POST /auth/qr/start

**Auth:** Anonymous (desktop side).

**Body:** `{}` (no input).

**Response:**
```json
{ "result": true, "data": {
    "session_id":  "<base64url, 43 chars>",
    "approve_url": "https://<host>/#/qr-approve?s=<session_id>",
    "expires_at":  1700000000000,
    "ttl_ms":      300000
}, "timestamp": ... }
```

### POST /auth/qr/approve

**Auth:** Authenticated (mobile side).

**Body:** `{ "session_id": "..." }`.

**Response:** `{ "result": true, "data": { "approved": true } }` or a
soft error if expired / already approved.

### POST /auth/qr/poll

**Auth:** Anonymous (desktop polling). Sets cookie when transitioning
to `consumed`.

**Body:** `{ "session_id": "..." }`.

**Response data:** `{"status": …}`, one of `"pending"`, `"expired"`,
`"rejected"` or `"consumed"`. On the poll that *performs* the
transition to `consumed`, the reply also carries `user: {tid, username}`
and sets the cookie; a later poll of the same already-consumed session
reports `consumed` with neither.

`"approved"` is never observed on the wire — an approved session is
transitioned to `consumed` within the same request. `"expired"` is also
what an **unknown** `session_id` returns, deliberately, so polling is
not an oracle for which ids exist.

### POST /auth/qr/reject

**Auth:** **none — deliberately.** Body: `{session_id}`. Cancels a
pending QR handshake from the phone side.

**Response:** `data: {rejected: true}` on success, or HTTP 200
`{result:false, msg:"QR session not found, expired, or already
approved."}` — byte-identical to `/auth/qr/approve`'s failure message,
so neither endpoint can be used to probe which session ids are real.

**Why there is no gate here, when `/approve` requires one.** Approving
*asserts an identity* ("sign that desktop in as me"), so it needs a
session. Refusing asserts nothing; the person holding the phone that
scanned the code just wants to say "not this" — and that phone very
often has not signed in yet, which is the exact situation the flow
exists for. So the gate is possession of the `session_id` and nothing
more.

That is not an open door. The session id is 32 random bytes — 256 bits
— and it is the *same* secret that already gates `/auth/qr/poll`, which
is strictly more powerful because it mints a cookie. Anyone who could
guess it could already consume the sign-in; being able to cancel it adds
no capability. The blast radius of a mistaken reject is one aborted
handshake, and the desktop simply starts another.

**Rejection is legal only from `pending`.** A Cancel that races in after
an Approve cannot revoke a session that has already been handed out.

### POST /auth/telegram/link

**Auth:** Authenticated. Binds a Telegram identity to the caller's
account. Body is the raw Telegram Login Widget payload:
`{ id, first_name?, last_name?, username?, photo_url?, auth_date,
hash }`. Verifies HMAC against `TFL5_TELEGRAM_BOT_TOKEN`. Rejects if the
Telegram ID is already linked to another user.

### POST /auth/telegram/unlink

**Auth:** Authenticated. Body ignored. Removes the link row.

### POST /auth/telegram/login

**Auth:** Anonymous. Same body shape as `/link`. Sets `_token` cookie
when the Telegram ID matches a linked user.

### POST /auth/telegram/status

**Auth:** Authenticated (401 without a valid cookie). Body ignored.

**Response `data`:** `{ configured: bool, bot_username: string|null,
linked: { telegram_id, telegram_username, linked_at, last_login_at } |
null }`.

### POST /auth/phone/start

**Auth:** Anonymous. Phone OTP request.

**Body:** `{ "phone": "0xxxxxxx | +<country>xxxxxxx", "redirect_to": "..." }`.

**Response:** opaque success regardless of phone validity.
Includes `dev_otp` field only when `TFL5_PHONE_OTP_DEV_ECHO=true` is set
(local dev only).

**Caps:** at most 3 outstanding OTPs per phone number.

**Delivery:** the OTP is dispatched through the operator registry — the
operator id comes from `TFL5_PHONE_OTP_OPERATOR_ID` (default
`zalo-zns`; the accepted set is `zalo-zns` and `viettel-sms`), its
config is read from the app named by `TFL5_PHONE_OTP_APP_TID`, and the
template / parameter keys from `TFL5_PHONE_OTP_TEMPLATE_KEY` (default
`phone_otp`) and `TFL5_PHONE_OTP_PARAM_KEY` (default `otp`). Whether the
operator is configured on a given cell is an operator decision — a
delivery failure is logged and swallowed so the response shape cannot be
used to probe. The OTP row still exists, so a retry works once delivery
is fixed.

### POST /auth/phone/verify

**Auth:** Anonymous. Validates the OTP, sets `_token` cookie.

**Body:** `{ "phone": "...", "code": "6-digit", "redirect_to": "..." }`.

**Response (success):**
```json
{ "result": true,
  "data": { "user_tid": "u-...", "redirect_to": "/#/apps" },
  "timestamp": 1700000000000 }
```
(An older release exposed a standalone `ok` field; it has been removed.)

**Notes:** 10-min TTL per OTP, max 5 attempts. New phones auto-create
a user (`auth_methods=['phone']`, placeholder username
`phone_<last4>_<rand4>`).

### POST /auth/vneid/start

**Auth:** Anonymous. The handler only requires that the named app has
the `vneid` operator enabled and configured — it does not read the
session cookie.

**Body:** `{ "app_tid": "...", "redirect_to": "..." }`.

**Response:** `{ result, state, authorize_url, warning?, timestamp }`.

**Not production-wired as shipped.** `authorize_url` resolves to an
environment default unless the app's operator config supplies a real
merchant URL; while it does not, the response carries an explicit
`warning` field so a UI can degrade gracefully. Check for `warning`
before treating this as a live identity flow.

### GET /auth/vneid/callback?code=&state=

**Auth:** Anonymous. Validates the state, sets the `_token` cookie.

**Dev bypass:** when the environment variable
`TFL5_VNEID_DEV_NATIONAL_ID` is set, the callback uses that value as the
national id instead of the OAuth result. That is a development
affordance — on a cell where it is set, this endpoint is not proof of
identity.

### GET /auth/sso?return_to=<absolute-url>

**Auth:** Authority host only (`TFL5_SSO_AUTHORITY_HOST`). Issues a
30-second handoff token bound to `return_to` host, redirects to
`https://<host>/_sso/accept?_sso=<token>&return_to=<path>`. If not
yet logged in on the authority, bounces to `/?continue=...`.

### GET /_sso/accept?_sso=&return_to=

**Auth:** Verifies the handoff HMAC + host binding, sets a local
`_token` cookie (no Domain attr — per-host), redirects to the safe
relative `return_to`.

---

## User account

### POST /user

**Auth:** Authenticated. Body: none.

**Response:**
```json
{ "result": true,
  "user": {
    "tid": "u-...", "username": "...", "license_tid": "...",
    "app_count": 3,
    "groups":    [ { "tid": "g-...", "name": "..." } ],
    "app_roles": { "a-...": [ { "tid": "r-...", "name": "..." } ] },
    "scope_bindings": { "a-...": [ { "scope": "...", "params": [...],
                                     "role_code": "..." } ] }
  },
  "platform": { "test_subdomain_base", "google_client_id",
                "microsoft_client_id", "telegram_bot_username" },
  "timestamp": ... }
```
`groups` / `app_roles` / `scope_bindings` are always present — this is the
call a client uses to render "what am I allowed to do". Returns
`{ "isSignout": true, "result": true }` if the cookie is missing/invalid.

### POST /user/profile

**Auth:** Authenticated. Body: none. Extended account info for a settings
page. No `platform` block (that is only on `/user`).

**Response `user` fields:** `tid, username, license_tid,
license:{tid,name,description,user_max_apps,user_max_total_storage,
app_max_storage}|null, email, name, mobile, email_verified,
emails:[{email_hash,email,unreadable,is_primary,verified,added_at,verified_at}],
auth_methods[], has_password, app_count, total_used_storage, created_at,
erase_requested_at, erase_after, unreadable[]`.

**PII is decrypted on the fly, and `unreadable` tells you when that
failed.** A `null` PII field used to mean two incompatible things —
"the user never filled this in" and "the ciphertext exists but this cell
cannot open it right now" — and nothing on the wire distinguished them.
It does now:

- **`user.unreadable`** is an array of field names whose stored
  ciphertext could not be decrypted on this request. It contains only
  `"email"`, `"name"` and/or `"mobile"`; it is `[]` on a healthy
  account and is never null or absent.
- **`emails[].unreadable`** is a **boolean** on each address row (not an
  array). When true, that row's `email` is `null` for the same reason.
  The identical flag appears on `/user/email/list` rows.

**The reading rule:** a null field is "not filled in" **only if its name
is absent from `unreadable`**. Present in `unreadable` means the value
exists and this cell could not open it — typically a half-finished
master-key rotation. Do not render it as empty, do not offer to
"restore" it by having the user retype it, and do not treat it as
consent to overwrite. The response still succeeds: one unopenable column
does not fail the profile.

> Note the deliberate contrast with document data. Account PII degrades
> per field; encrypted **doc** fields do not degrade at all — one
> unopenable cell fails the whole read with a 500. See [One unopenable
> cell fails the whole read](#one-unopenable-cell-fails-the-whole-read).

### POST /user/profile/update

**Auth:** Authenticated.

**Body:** `{ "name"?: "...", "mobile"?: "..." }`. Omitted = leave
unchanged; empty string = clear the column. Does **not** touch email or
username — those have their own flows. Returns
`{result:true, msg:"Profile updated"|"Nothing to update"}`.

### POST /user/change-password

**Auth:** Authenticated.

**Body:** `{ "current": "...", "new": "...", "re_new": "..." }`.

**Notes:**
- New password must be ≥ 6 chars and match `re_new`.
- Refuses for accounts without `'password'` in `auth_methods`
  (e.g. Google-only). Opaque "Current password is incorrect" on
  failure (no timing leak vs `/login`).
- Fires `auth.password.changed` audit row.

### POST /user/set-password

**Auth:** Authenticated. Gives a **passwordless** account (Google /
Microsoft / magic-link / phone) its first password.

**Body:** `{ "new": "...", "re_new"?: "...", "code"?: "<totp>" }`.
`re_new` is only compared when non-empty. `code` is required when the
account has a confirmed 2FA enrolment.

**Codes:** `has_password` (account already has one — use
`/user/change-password`), `totp_required`.

**Side effects:** adds `'password'` to `auth_methods`, invalidates every
other session, re-mints the caller's own cookie.

### POST /user/username/change

**Auth:** Authenticated. **Body:** `{ "new_username": "..." }` (min 2
chars). Rejects duplicates. Invalidates other sessions and re-mints the
caller's cookie. Returns `{result:true, msg, username}`.

### POST /user/link

**Auth:** Authenticated. Attaches an OAuth identity to the signed-in
account.

**Body:** `{ "provider": "google" | "microsoft", "credential": "<id token>" }`.

The provider's verified email must already be one of the account's own
emails (primary or a verified secondary) — there is **no** cross-account
merge. Otherwise `code: "email_mismatch"`. Success returns the updated
`auth_methods[]`.

### Email addresses (multi-email)

An account has one **primary** email (the one used for login recovery and
`users.email_verified`) plus any number of verified secondaries. Only
`/user/email/promote-primary` changes the primary.

| Endpoint | Auth | Body | Notes |
|---|---|---|---|
| `POST /user/email/list` | Authenticated | none | `{result, emails:[{email_hash, email, is_primary, verified, added_at, verified_at}]}`, primary first |
| `POST /user/email/add` | Authenticated | `{email}` | Added unverified; sends a verification mail. Duplicate against *anyone's* address → `validation_email_taken` (deliberately indistinguishable) |
| `POST /user/email/remove` | Authenticated | `{email_hash}` | hex SHA-256 of the address, from `/user/email/list`. Cannot remove the primary → `validation_email_primary` |
| `POST /user/email/promote-primary` | Authenticated | `{email_hash}` | Refuses unverified addresses → `validation_email_unverified`. Already-primary is a no-op success |
| `POST /user/email/send-verification` | Authenticated | `{email_hash}` | Re-sends for **any** of the caller's addresses |

Shared codes: `validation_invalid` (malformed address / bad hash),
`not_found`.

### POST /user/send-verification

**Auth:** Authenticated. Body: none. Sends a verification mail for the
account's **primary** address only (use `/user/email/send-verification`
for a specific one). Returns `{result, msg}`; `result:false` with a
reason when already verified or when the mail transport is not configured
on the cell.

### GET /verify-email?token=...

**Auth:** Anonymous. Returns an HTML page (`text/html`), always HTTP 200,
whatever the outcome. Marks the matching address verified (24 h token
TTL) and mirrors `users.email_verified = TRUE` when that address is still
the account's primary. Idempotent.

### Data export & erasure (PDPD / GDPR)

### POST /user/data/export

**Auth:** Authenticated — strictly self-scoped, any account may export
its own record.

**Response `data`:** `exported_at`, `regulation`,
`account:{tid,username,license_tid,created_at,email_verified,used_storage,app_count}`,
`emails:[{is_primary,verified,added_at,verified_at}]` (**no plaintext
addresses** — those come from `/user/email/list`),
`app_memberships:[{app_tid,app_name,manager,editor,reader}]` (direct
membership only, not membership inherited through a group or role), plus
two explanatory `note` strings. Documents and files inside an app are
exported through that app's own `/app/doc/*` and `/app/file/*` APIs.

### POST /user/data/erase

**Auth:** Authenticated **plus a second factor**: the account's password
if it has one (`code: "password_required"`), otherwise a valid TOTP /
backup code when 2FA is enrolled (`code: "totp_required"`).

**Body:** `{ "password"?: "...", "code"?: "..." }`.

**Refused** with `code: "owns_apps"` (and the offending `app_tids[]`) if
the caller still authors any live app — transfer or delete them first.

**Behaviour:** stamps an erasure request and logs the caller out
immediately. The actual erase runs later, after a grace window
(`erase_after` in the response; operator-configured, 24 h default,
clamped 1–72 h). Repeat calls keep the **first** timestamp — the grace
window never restarts.

### POST /user/data/erase/cancel

**Auth:** Authenticated (sign in again inside the grace window).
Body: none. `code: "no_pending_erasure"` when there is nothing to cancel.

### POST /user/2fa/enroll

**Auth:** Authenticated. Always overwrites prior enrolment.

**Response data:** `{ provisioning_uri, secret_base32, backup_codes[],
confirmed: false }`. Frontend renders the URI as a QR for the
authenticator app. **The secret + backup codes are returned ONLY here;
never re-fetchable.** User must call `/user/2fa/confirm` to activate.

Re-enrolling over a **confirmed** enrolment is refused
(`twofa_already_confirmed`) — disable first.

### POST /user/2fa/confirm

**Auth:** Authenticated. Body: `{ "code": "6-digit" }`. Activates the
enrolment when the TOTP matches. Codes: `twofa_not_enrolled`,
`twofa_invalid`. Confirming twice is a no-op success.

### POST /user/2fa/verify

**Auth:** Authenticated. Body: `{ "code": "6-digit OR backup-code" }`.
In-session step-up challenge. On success sets the `_2fa_verified`
cookie and returns `{verified:true, valid_until}` (30-minute TTL by
default). Backup codes are consumed on use.

**Lockout:** 5 failed challenges within 15 minutes locks the account out
of this endpoint — HTTP **429**, `code: "twofa_locked"`, with
`retry_after_ms`. While locked, even a correct code is refused.

Other codes: `twofa_not_enrolled`, `twofa_not_confirmed`,
`twofa_invalid`.

### POST /user/2fa/disable

**Auth:** Authenticated + valid TOTP/backup code. Body: `{ "code": "..." }`.
Wipes the enrolment and drops the 2FA cookie. Calling it while not
enrolled is a no-op success (`{disabled:true, was_enrolled:false}`).

### POST /user/2fa/regenerate-backup-codes

**Auth:** Authenticated + valid TOTP/backup code. Body: `{ "code": "..." }`.
Returns a fresh `backup_codes[]` array; every prior code is invalidated.

### POST /user/2fa/status

**Auth:** Authenticated. Body: none. Returns
`{ enrolled, confirmed, enrolled_at, last_used_at,
backup_codes_remaining }`. Never returns the secret or code hashes.

---

## Identity facets (avatar / display name sharing)

A user stores a small set of personal **facets** and chooses who may see
them. Two facets exist today: `avatar` (a `data:image/{png,jpeg,webp}`
URL, ≤ 96 KB) and `display_name` (1–64 chars). All endpoints are
self-scoped — you can only write your own facets and read what others
have granted you.

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `POST /user/identity/get` | Authenticated | none | `{facets:{avatar,display_name}}` — your own |
| `POST /user/identity/set` | Authenticated | `{facet, value}` | `{result:true}` |
| `POST /user/identity/remove` | Authenticated | `{facet}` | `{result:true}`; also revokes every grant on that facet |
| `POST /user/identity/share` | Authenticated | `{facet, audience_type, audience_ref, expires_at?}` | `{grant_id}`; idempotent per tuple |
| `POST /user/identity/revoke` | Authenticated | `{grant_id}` **or** `{facet, audience_type, audience_ref}` | `{revoked: <count>}` |
| `POST /user/identity/grants` | Authenticated | none | your own active grants |
| `POST /user/identity/resolve` | Authenticated | `{user_tids[], app_tid?, facets?}` | `{identities:[{user_tid, username, facets}]}` |
| `POST /user/identity/access-log` | Authenticated | `{facet?, since?, limit?}` | who viewed **your** facets |

`audience_type` ∈ `user | group | role | app_members`. `resolve` caps at
300 user tids per call (extras are dropped), defaults to both facets when
`facets` is omitted, and discloses nothing for banned or erased
subjects. `access-log` returns at most 200 rows (default 50), newest
first, and each row is `{viewer_username, facet, action, granted,
app_context, accessed_at}` — `viewer_username` and `app_context` may be
null. The payload key is `log`, not `data`.

**What the log records, and what it deliberately does not.** `action` is
either `"resolve"` (with `granted: true`) or `"deny"` (with
`granted: false`), and the writing rule is not symmetrical:

| Situation | Row written? |
|---|---|
| Someone else's facet disclosed to a viewer | **yes** — `resolve`, one per facet |
| A viewer refused **every** facet they asked for | **yes** — `deny`, one per refused facet |
| A viewer refused **some** facets but granted others | **no** row for the refused ones |
| You viewing your own facets | no |
| Any lookup of a subject with `erased_at` set | no — nothing at all |
| The subject simply has that facet unset | no |

The partial-refusal hole is deliberate, not an oversight. A viewer who
holds a grant on `avatar`, asks for the default `[avatar,
display_name]`, and gets one of them is what *every ordinary render of a
user list* looks like — for every viewer legitimately admitted, on every
page. Logging it would write a "denied" row per render and push the
probes actually worth seeing off the end of a log that holds at most 200
rows. So the log answers **"who was turned away entirely"**, which is
the shape of somebody fishing, and stays quiet about the routine partial
grant. If you are auditing for probing, a run of `deny` rows is your
signal; the absence of one does not prove nothing was refused.

Codes: `facet_invalid`, `avatar_too_large`, `avatar_invalid`,
`display_name_invalid`, `audience_type_invalid`, `audience_ref_required`,
`revoke_target_missing`. These endpoints answer **401** when not signed
in (rather than the `isSignout` envelope).

---

## Apps

### POST /app/update

Dual-purpose:
- **`tid` absent** → create new app. Owner becomes the caller.
- **`tid` present** → edit existing app.

**Auth (create):** Authenticated + **email verified** + app-creation
quota.
**Auth (edit):** Manager on the app.

**Create quota — two models.** The account carries a consumable balance
(`app_create_rights` bought via [`/billing/app-rights/*`](#app-creation-rights)
minus `apps_created_total`). When that balance has never been
provisioned the platform falls back to the license-tier cap
(`user_max_apps`, or a per-user override). Either way, exhaustion is
`code: "quota_exceeded"` — but at **HTTP 402**, and `data` names *which*
model you hit, because the remedy differs:

```json
{ "cap": "app_create_rights", "rights": 5, "created": 5,
  "remaining": 0, "refundable_on_delete": false }
```
```json
{ "cap": "user_max_apps", "max": 3, "used": 3,
  "refundable_on_delete": true }
```

`refundable_on_delete` is the field to branch a UI on: deleting an app
frees a `user_max_apps` slot immediately, and gives back **nothing** on
the rights model — rights are consumed for good. Note `remaining` appears
on the rights shape only.

**Body:**
```json
{
  "tid":  "a-xxx",                  // optional; presence = edit mode
  "data": {
    "name":        "string",        // required on create, ≤ 200 chars
    "description": "string",        // optional, ≤ 2000 chars
    "icon":        "data:image/...",// optional; small inline data URL
    "single_page": "index.html",    // optional SPA shell — see below
    "error_page":  "404.html"       // optional custom 404 — see below
  }
}
```

**`single_page`** names an HTML file (relative to the app's served
root). When set, a deep link that matches no file serves that shell
instead of a 404 — HTML5-history routing for SPAs. It applies **only to
extension-less paths**: a miss that looks like an asset (`/img/a.png`)
is an asset fetch, not a route, and still gets a real 404.

**`error_page`** names an HTML file served when nothing else matched.
Unlike the SPA shell it is served at a **real HTTP 404**, with
`Cache-Control: no-store` and no ETag, so crawlers and caches read it as
the error it is. It works across all four serve tiers (file stage,
object storage, snapshot and bundle).

Both are tri-state: a path sets, `""` clears, omitting preserves.
Editing either needs **Manager**.

> **`error_page` does not un-soft-404 an SPA, and that is permanent.**
> When an app sets both, the SPA shell is tried **first**, so
> extension-less paths keep getting the shell at HTTP 200 and
> `error_page` never sees them. This is not a gap awaiting a follow-up:
> the server cannot know whether `/dashboard` is a real client-side
> route or a typo, and returning a 404 page for one would break the app.
>
> So the division of labour is fixed:
> - **asset-shaped misses** (anything with an extension) → `error_page`,
>   at a real 404;
> - **extension-less misses on an SPA** → the shell, at 200;
> - **static sites with no `single_page`** → `error_page`, at a real
>   404, for everything.
>
> If you are chasing soft-404 warnings in a search console for an SPA,
> `error_page` will not fix them. The fix has to come from your own
> router rendering a not-found view — the platform cannot make that call
> for you.

**ACL fields are rejected here, on both branches.** Passing
`managers`/`editors`/… (flat or nested under `acls`) fails with
`app_update_no_acl_fields` / `app_update_no_nested_acls` rather than
being silently dropped. Use [`/app/acl-set`](#post-appacl-set) or the
[member endpoints](#members--app-acl-admin).

**Response (success):** `{ result, data: <app row>, timestamp }`.

**Notes:**
- Validation soft-failure: `{"msg":"Name invalid","code":"validation_invalid"}`.
  A spent create quota is **not** in that class — it is a 402 refusal
  (above), with `data` naming the cap.
- Side effects on create: per-app encryption key row (KMS-wrapped),
  `app.create` audit row, owner's app counters incremented in the same
  transaction.
- Full-resolution logo: upload separately (e.g. to
  `assets/logo.<ext>`) — see [Publishing](#publishing-a-frontend).

### POST /app/list

**Auth:** Authenticated. Returns every app where the caller is `author`
or appears in `managers` / `designers` / `editors` / `readers` — directly
or through a role (`[r-…]`) or group token — minus any app where one of
the caller's tokens sits in `noaccess`. Soft-deleted apps excluded.

**Response data:** array of `{tid, name, description, icon, single_page,
used_storage, created_at, updated_at}`, sorted by `created_at DESC`.

### POST /app/get

**Auth:** Reader on the app.

**Body:** `{ "tid": "a-xxx" }`.

**Response data:** the app row — `tid, name, description, icon,
single_page, error_page, author, license_tid`, the six ACL arrays
(`managers, designers, editors, readers, deletable, noaccess`), joined
license info (`license: {tid, name, description, app_max_storage,
user_max_apps, user_max_total_storage}`), plus:

- **`my_level`** — what *this caller* may do here, one of `"owner"`,
  `"manager"`, `"designer"`, `"editor"`, `"reader"`. It is decided by the
  same function every gate calls, so a screen that hides a control on it
  cannot disagree with the server. **Use this instead of reading the ACL
  arrays.** Those arrays hold role and group tokens (`[r-…]`, `G_…`) that
  only the server can resolve, so a front-end that infers a level from
  them is building a second, wrong ladder.
- **`error_page`** — the custom 404 page path, or `null`.
- **`domains_quota`** — `{max, used}`, or **`null`** when the quota could
  not be resolved. Null means *unknown*, never zero and never unlimited;
  the server declines to guess, so a UI must not either.

An unknown or inaccessible `tid` also answers `access_denied` — by
design you cannot tell "no such app" from "not yours".

### POST /app/acl-set

**Auth: Manager is the floor, not the gate.** The level actually required
is `strictest(Manager, ladder(buckets this call touches))`, where the
ladder is:

| Bucket touched | Level it demands |
|---|---|
| `managers` | **Owner** |
| `designers` (and the retired `developers`) | Manager |
| `editors`, `readers`, `deletable`, `noaccess` | Designer |
| *no bucket touched* | Designer |

The strictest demand across the buckets in play wins, then the endpoint
floor holds it at Manager or above. **Owner means `apps.author` and
nobody else** — no role, group or ACL entry can confer it — so appointing
or removing a Manager is reachable only by the app's author, however many
Managers an app has.

**This endpoint prices the *change*, not the payload.** Each bucket is
compared against its stored value by set-equality after normalisation
(sorted, deduped, role tids bracketed), so re-posting a `managers` array
identical to the one already there counts as untouched and demands no
escalation. Only a bucket whose contents actually differ pulls its rung
of the ladder in.

**Body:** every ACL field is optional; omitted = preserve. There are six
arrays — a `developers` key was retired from the API surface and is
silently dropped if you send it.
```json
{
  "app_tid":    "a-xxx",   // required
  "managers":   ["..."],
  "designers":  ["..."],
  "editors":    ["..."],
  "readers":    ["..."],
  "deletable":  ["..."],
  "noaccess":   ["..."]
}
```

**Guardrails — three checks, all skipped for the author.** They apply
only when the caller is *not* the app's author; the author is exempt
from all three, so ownership stays an unrescindable recovery path.

- **Cannot remove themselves from `managers`.**
- **Cannot add themselves to `noaccess`.**
- **Cannot remove the app's author from `managers`.** Without this a
  Manager could rewrite `managers` to a set excluding the owner. It is a
  **delta** check, not a presence check: it fires only when the author
  *was* in `managers` and the new array drops them. An app whose author
  was never listed in `managers` is unaffected, which is what lets a
  Manager edit an unrelated bucket without tripping it.

The first two are evaluated against the caller's **full** permission set
— role tokens (`[r-…]`), group tids, username and user tid — not their
bare user tid. Checking the tid alone both false-rejected managers who
hold their access through a role and gave false protection, because it
missed the removal of the very role that granted the access.

Failures are plain **400** `bad_request` with an explanatory `msg` and
no dedicated `code`; match on the status.

The same three checks apply to all three incremental
[`/app/acl/*`](#incremental-acl-editing-appacl) writers —
`/app/acl/set`, `/app/acl/revoke` and `/app/acl/bulk-import` — which
share one implementation with this endpoint's inline copy.

**`/app/member/set-direct-grants` does not run them.** It reaches the
same ACL arrays through a different path with no lock-out guard of its
own, so it is gated by the [bucket ladder](#post-appacl-set) alone —
touching `managers` demands Owner, and Owner is the one caller all three
checks exempt anyway. The practical consequence is narrow but real: the
ladder, not a self-lockout guard, is what protects those arrays on that
endpoint.

**Caps:** 5000 entries per array → `acl_array_too_large`.

**Role tids are bracket-wrapped.** A bare `r-…` is normalised to
`[r-…]` on the way in — the bracket form is what the evaluator matches.
This is the one place the legacy underscore form bites: an `r_…` string
is *not* recognised as a role tid, so it lands as an inert literal that
grants nothing.

**Response:** `{result, data:{tid, managers, designers, editors, readers,
deletable, noaccess, updated_at}, timestamp}`.

**Side effects:** the app's ACL cache is invalidated; an `app.acl_set`
audit row captures the full after-state.

### POST /app/transfer-ownership

**Auth:** Owner only.

**Body:**
```json
{ "app_tid": "...", "new_owner_tid": "u-xxx",
  "keep_old_as_manager": false, "reason": "..." }
```

**Notes:** new owner must exist + unbanned. Flips `apps.author`, adds
new owner to `managers[]`, removes old owner from `managers[]` unless
`keep_old_as_manager: true`. Writes append-only `app_ownership_log`
row + `app.transfer-ownership` audit.

### POST /app/invite-user

**Auth: Editor on `app_tid` is the floor.** When the `role_tids` list is
empty *after* the app-membership filter below — including the case where
you sent none — the call also writes a direct `apps.readers` grant, so it
takes the level that bucket demands and the gate becomes **Designer**. An
invite that names at least one role belonging to the app stays at Editor.

**The roleless invite now grants something.** It used to attach no role,
write no grant, and still answer `result:true`: the person accepted the
invitation and then could not open the app. A roleless invite now adds
the invitee to `apps.readers` (idempotently), on **both** branches — the
existing-user branch and the new-user magic-link claim path — so the
invitation and the access arrive together.

**Body:**
```json
{
  "app_tid":     "a-xxx",                          required
  "email":       "parent@example.com",             required
  "role_tids":   ["r_parent_of_xxx"],              optional
  "redirect_to": "https://app.example.com/#/...",  optional, validated like /auth/email-link
  "note":        "Parent of student 23001..."      optional, free-text
}
```

**Branches by user existence:**

- **No user with matching email_hash:** create `user_invites` row +
  mint a magic-link token + send email (same engine as
  `/auth/email-link`). Response:
  `{result:true, data: {tid:"iv-xxx", email_hash_b64:"...", status:"sent"}}`.
  When the user clicks the link, the `/auth/magic` claim handler:
  - creates the user (`email_verified=true`, `_token` cookie set),
  - looks up all unclaimed `user_invites` matching this magic_token_tid,
  - atomically adds the new user_tid to each invite's `role_tids` members
    + stamps the invite as claimed.
- **User exists (email_hash match):** do NOT send email. Add the
  existing user_tid to the listed `role_tids` immediately (idempotent
  membership append). Response:
  `{result:true, data: {tid:"iv-xxx", user_tid:"u-yyy", status:"user_already_exists"}}`.

**Anti-enumeration / rate-limit:**
- Invalid email shape → opaque success `{status:"would_send"}` with no
  DB row written.
- Cap 20 unclaimed invites per (`app_tid`, `email_hash`, rolling 24h).
  Beyond → opaque success without effect.

**Side effects:**
- `audit_log` row for the invite create.
- `role_tids` not belonging to the app are silently filtered out
  (defence against stale UI).

### POST /app/del

**Auth:** Owner only.

**Body:** `{ "tid": "a-xxx" }`.

**Behaviour:**
- First call → soft-delete (`apps.deleted_at = now`). Response:
  `{ tid, soft_deleted:true, deleted_at, hard_delete_after }`
  (90-day window).
- Second call on already-soft-deleted app → hard delete + best-effort
  storage cleanup across both stages. Response:
  `{ tid, hard_deleted:true, files_removed, errors[] }`.

### POST /app/upgrade-license

**Auth:** Manager on the `app_tid`.

**Body:**
```json
{ "app_tid": "a-xxx",
  "target": "app" | "user",
  "requested_tier": "free|pro|enterprise|...",
  "reason": "string" }
```

Creates a pending `license_requests` row. Duplicate pending requests
for the same `(app, target, target_tid)` are rejected.

### POST /app/upgrade-license/list

**Auth:** Reader on `app_tid`. Returns the app's last 100 license
requests with status + decision metadata.

### POST /app/upgrade-license/cancel

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`. Cancels **any**
pending request on that app — not just one the caller filed. Unknown or
already-decided requests answer `{result:false, msg}` (no `code`).

---

## Members & app ACL admin

Two families sit on top of the *same* storage as `/app/acl-set` — the
seven `apps.*` ACL arrays plus `roles.members`. Nothing here is a second
permission model; they are ergonomics for building an admin screen.

### The member view

A **member** of an app is anyone who appears in one of the app's role
member lists, in one of its ACL arrays, or is its author. Group
membership is deliberately **not** expanded into this view.

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `POST /app/member/list` | Designer | `{app_tid, search?, role_filter?, limit?, offset?}` | `{data:[…], total, limit, offset, next_offset}` |
| `POST /app/member/get` | Designer | `{app_tid, user_tid}` | one member card; `not_found` if the user has no roles, no direct grant and isn't the author |
| `POST /app/member/search` | Designer | `{app_tid, query, limit?}` | `[{user_tid, username, display_name}]` — find a person who is **not yet** a member, so you can add them |
| `POST /app/member/set-roles` | **Manager** | `{app_tid, user_tid, role_tids[]}` | `{roles, added, removed}` |
| `POST /app/member/set-direct-grants` | see below | `{app_tid, user_tid, grants:{<array>:bool}}` | `{applied:{…}}` |
| `POST /app/member/remove` | Designer | `{app_tid, user_tid}` | strips the user from every role **and** every ACL array of the app |

A member card is `{user_tid, username, display_name, phone, email,
created_at, roles:[{tid,name}], direct_grants:[<array names>],
is_author}`. `list` caps at 200 rows (default 50). Dangling ACL entries
(a tid with no surviving user) come back as a `stale: true` stub with
null PII.

- `set-roles` edits **role membership** (`roles.members`) — it is
  Manager-gated because a role tid can itself sit in `managers[]`, so a
  Designer granting themselves such a role would be privilege
  escalation.
- `set-direct-grants` edits the app's ACL arrays directly, and its
  required level scales with what you touch by the [same
  ladder](#post-appacl-set): `managers` → **Owner**; `designers` /
  `developers` → **Manager**; anything else → **Designer**.
  Omitted array names are left unchanged. Unknown array name →
  `validation_invalid`. Two more refusals, both recent and both worth
  handling: an empty `user_tid` → `validation_invalid`, and a **grant**
  naming a user who does not exist → `user_not_found`. Existence is
  checked on grants only — a *revoke* deliberately skips it, so a deleted
  account's leftover access can still be stripped. Before those checks
  existed, such a call answered `result:true` and spliced a blank or dead
  entry into a live ACL array.
- `search` is the one person-lookup an ordinary app owner can reach.
  `query` must be ≥ 2 characters after trimming, else `query_too_short`;
  `limit` defaults to 10 and clamps to 25. It matches on **username
  only** (case-insensitively, with `%` and `_` treated as literals) and
  excludes banned accounts. The platform's own directory search lives
  behind `/admin/users/list`, which requires naming the platform-admin
  app *and* being a Manager of it — an app owner naming their own app
  gets a signout envelope, not results — so this endpoint, not that one,
  is how an admin screen finds somebody to invite.
- `remove` refuses only on the app's **author** (HTTP **409**, `code:
  "owner_protected"`) — transfer ownership first.

> **`remove` is Designer-gated and strips everything, including
> `managers`.** One statement clears the user from all seven `apps.*` ACL
> columns — `managers, designers, developers, editors, readers,
> deletable, noaccess` — and a second clears every role they hold in the
> app. There is no lockout guard here beyond the author check, so:
> - a **Designer can demote any Manager** who is not the app's author;
> - the same call **lifts that person's `noaccess` veto**, because
>   `noaccess` is cleared along with the grants.
>
> If you deliberately vetoed someone by putting them in `noaccess`,
> "removing" them undoes the veto rather than reinforcing it. Only the
> author is unremovable, and only the author can put a Manager back.

### Incremental ACL editing (`/app/acl/*`)

`/app/acl-set` replaces all six buckets in one shot. These are the
surgical equivalents over the same columns, all with **Manager as the
floor and the [same bucket ladder](#post-appacl-set) on top** — touch
`managers` and the call needs **Owner** — all subject to the same
5000-entries-per-array cap (`acl_array_too_large`) and the same
[three-check lock-out guard](#post-appacl-set) — a non-owner Manager may
not remove themselves from `managers`, add themselves to `noaccess`, or
remove the app's author from `managers`. All three share one
implementation with `/app/acl-set`, so the three endpoints below cannot
drift from it.

> **The one trap worth knowing before you port a screen.**
> `/app/acl-set` prices the **change**; `/app/acl/bulk-import` prices
> **presence**. Bulk-import asks only whether a bucket key was *supplied*
> — so a "save all six arrays" dialog that posts `managers` every time,
> unchanged, is free on `/app/acl-set` and **demands Owner** on
> `/app/acl/bulk-import`. The same dialog, moved from one endpoint to the
> other, silently stops working for every Manager who is not the author.
> On bulk-import, omission is the only discount: send only the buckets
> you mean to change.

| Endpoint | Body | Effect |
|---|---|---|
| `POST /app/acl/list` | `{app_tid}` | read all six buckets — the read counterpart `/app/acl-set` never had |
| `POST /app/acl/set` | `{app_tid, bucket, members[]}` | replace **one** bucket |
| `POST /app/acl/revoke` | `{app_tid, bucket, member}` | remove one principal from one bucket, idempotent |
| `POST /app/acl/bulk-import` | `{app_tid, grants:{managers?,designers?,editors?,readers?,deletable?,noaccess?}}` | replace the buckets you supply, preserve the rest |

Buckets are `managers, designers, editors, readers, deletable,
noaccess`. Bare role tids are bracket-normalised on the way in, so
passing `r-…` matches a stored `[r-…]`.

> **A misspelled bucket name is caught on two of these three endpoints
> and silently dropped on the third.**
>
> `/app/acl/set` and `/app/acl/revoke` take the bucket as a *string* and
> validate it: an unknown name is refused `unknown_acl_bucket`.
>
> `/app/acl/bulk-import` takes a typed `grants` **object** whose six
> keys are fixed fields. An unrecognised key does not match any of them
> and is **discarded during parsing** — before the handler runs, without
> a warning. The call then succeeds for whatever it did recognise and
> answers `result: true`.
>
> So `{"grants": {"manager": [...]}}` — singular, a plausible typo for
> `managers` — applies **nothing**, reports success, and leaves the real
> `managers` bucket untouched. There is no code to match on and no
> field in the response that reveals it.
>
> Two defences, since the server offers none: send only keys you have
> spelled from the list above, and **verify with
> [`/app/acl/list`](#incremental-acl-editing-appacl)** after a
> bulk-import rather than trusting `result: true`. This is the one place
> in the ACL surface where a successful response does not mean your
> request was understood.

### POST /app/role/list-for-user

**Auth:** Reader on `app_tid` to prove app visibility, **plus Manager**
unless you are asking about yourself.

**Body:** `{app_tid, user_tid}` → `{data:{roles:[{tid,name,description}]}}`.

Resolves the **effective** role set through the same hydration the
permission check uses, so it can never drift from what the ACL evaluator
actually sees. An unknown user returns an empty list rather than an
error (no existence leak).

---

## App config blob

A per-app JSON object the platform stores but never interprets — your
app's own namespace for settings.

### POST /app/config/get

**Auth:** Reader on `app_tid`. **Body:** `{app_tid, key?}`. Returns
`{data:{config: <whole blob, or just that key>}}`. Nothing is redacted:
anyone who can read the app can read every key. **Do not put secrets
here** — use an operator-configured integration
([`/app/integrations/config-set`](#post-appintegrationsconfig-set)),
whose config is encrypted at rest and Manager-gated.

### POST /app/config/patch

**Auth:** Manager on `app_tid`.

**Body:** `{app_tid, key?, value?, patch?}`. `patch` is merged first,
then `{key,value}` is applied on top. The merge is a **shallow,
top-level** merge — a patched key replaces its whole subtree.

Codes: `config_patch_empty` (neither form supplied), `config_too_large`
(a single patch may not exceed 256 KB serialised).

---

## Resources (schema)

Resources define the schema of a doc class (`Post`, `Student`, …).

### POST /app/resource/list

**Auth:** Reader on `app_tid`.

**Body:** `{ "app_tid": "...", "include_deleted": false }`.

**Response data:** array of resource summaries (`tid, ma, name,
description, fields, status, sharing, author, deleted_at, created_at,
updated_at`). Capped at 500 rows.

### POST /app/resource/get

**Auth:** Reader on `app_tid`. Body: `{app_tid, tid}`. Returns the
resource row: `fields`, `hooks`, `status`, `sharing`, `audit_writes` for
any Reader; the **control-plane** fields — the per-resource ACL arrays
(`managers, editors, designers, readers, authors, noaccess, deletable`)
and the four `*_code` hook bodies — are returned only to the app's
owner/managers. A plain Reader sees them as empty/`null`, so a rostered
user cannot enumerate the roster or read your hook source.

### POST /app/resource/create

**Auth:** Manager on `app_tid`.

**Body:**
```json
{
  "app_tid":     "a-xxx",                  required
  "ma":          "student",                required, [A-Za-z0-9_.:-]+
  "name":        "Student",                required
  "description": "string",                 optional
  "fields":      [ { "field": "...",       optional, default []
                     "name":  "...",
                     "level": 0,
                     "validator": "..." } ],
  "hooks":       [ { "type": "...", ... } ], optional, default []
  "readers":     ["..."], "editors": ["..."],   optional per-resource ACL
  "deletable":   ["..."], "noaccess": ["..."],
  "audit_writes": false                     optional
}
```

**Response:** `{data:{tid, ma, name}}`.

**Notes:**
- `(app_tid, ma)` is unique among active resources; duplicates are a soft
  `result:false` with a message.
- `fields[*].level` >= 1 = encrypted at rest (`data_secret`), and such a
  field can never be filtered on. It also puts the whole read path on an
  all-or-nothing footing — see [the decryption warning](#one-unopenable-cell-fails-the-whole-read)
  below before declaring a field encrypted.
- Creating a resource also creates its physical storage table. If that
  DDL fails, the partially-created resource row is rolled back.
- Hook shape is validated — bad shape fails with `hook_invalid_shape`.

### Field validators

`fields[*].validator` is a comma-separated token string, evaluated on
every doc write. Whitespace is tolerated; **unknown tokens are ignored**
(forward compatibility), so test a validator before relying on it.

| Token | Meaning |
|---|---|
| `required` | value must be present |
| `minlen:N` / `maxlen:N` | string length bounds |
| `min:N` / `max:N` | numeric bounds |
| `number` | value must be numeric |
| `email` | plausible email address |
| `date` | ISO `YYYY-MM-DD` · `datetime` — RFC 3339 |
| `choice:a\|b\|c` | value must equal one option |
| `multichoice:a\|b\|c` | array; every element must be an option |
| `link:<resource_ma>` | value is the tid of a doc in another resource |
| `multilink:<resource_ma>` | array of such tids |
| `rollup:<src_ma>:<link_field>:<agg>[:<value_field>]` | computed, read-only |

Options are `|`-separated so `,` stays the token separator; options
containing `|` or `,` are not supported — use a hook.

**Links are enforced, not decorative.** On every write the server
resolves each `link`/`multilink` value and rejects references to a
missing or deleted target: `link_resource_not_found` (the target
`resource_ma` doesn't exist) / `link_target_not_found` (the referenced
doc doesn't). Deleting a resource that another resource links to is
refused with `resource_referenced_by_link`.

**Rollups** are inverse-link aggregates (`count | sum | avg | min | max`)
computed at read time — e.g. `rollup:line_item:order:sum:amount` on an
`Order` field sums `amount` over the line items linking back to it.
`value_field` is required for every aggregate except `count`. Rollup
keys are stripped from write payloads; the value is always derived.

A validator failure is `code: "field_validation_failed"`.

### Hooks

`resources.hooks` is an array of declarative rules. Each entry needs an
`id`, a non-empty `on` array of lifecycle events, and a `type` — one of:

| `type` | Does |
|---|---|
| `require_fields` | rejects the write when a listed field is absent (`hook_validation_failed`; optional custom `msg`) |
| `set_fields` | derives/copies fields on write |
| `webhook` | POSTs to `params.url` — the URL is validated at registration time and non-`http(s)`, loopback, private-range and cloud-metadata targets are refused |
| `wasm` | invokes one of your [WASM operators](#wasm-operators--tenant-server-side-code); requires `params.op_id` |

Bad shape → `hook_invalid_shape`.

### JS code hooks

Beyond the declarative rules, a resource carries four nullable code
fields — `before_create_code`, `after_create_code`, `before_update_code`,
`after_update_code` — holding **JavaScript** that runs in an embedded
QuickJS sandbox at the doc lifecycle. They are set through
`/app/resource/update` (and readable only by owner/managers).

The code sees one global, `ctx`:

```js
ctx = {
  event: "before_create",     // which hook is firing
  data:  { ... },             // the incoming payload — mutable in before_*
  doc:   { ... } | null,      // current row (before_update, after_*)
  old_doc: { ... } | null,    // pre-update snapshot (after_update only)
  user: { tid, username, roles: [], groups: [] },
  resource: { tid, ma },
  app: { tid },
  now_ms: 1700000000000,
  reject: function (msg, code) { /* throws */ },
}
```

A `before_*` hook's mutations to `ctx.data` are what gets written;
calling `ctx.reject(...)` blocks the write (`code: "hook_reject"`, with
your own tag folded into the message). `after_*` hooks are side-effect
only — their return value is ignored.

**Sandbox:** ≤ 100 ms wall clock and ≤ 16 MiB heap per invocation;
single-shot evaluation with no event loop, no `async`, no top-level
`await`; no `fetch`, no `require`, no `process`, no filesystem — only the
JS standard library. Anything needing network or heavier compute belongs
in a [WASM operator](#wasm-operators--tenant-server-side-code) or a
`webhook` hook.

### POST /app/resource/update

**Auth:** Manager on `app_tid`.

**Body:** all fields optional except `app_tid` + `tid`. COALESCE-skip
semantics — omitted = preserve.
```json
{
  "app_tid", "tid",
  "name?", "description?", "fields?", "status?", "sharing?", "hooks?",
  "before_create_code?", "after_create_code?",
  "before_update_code?", "after_update_code?",
  "readers?":   ["..."],
  "editors?":   ["..."],
  "noaccess?":  ["..."],
  "deletable?": ["..."],
  "audit_writes?": true
}
```

**Per-resource ACL (REQ-TFL5-015):** `readers / editors / noaccess /
deletable` set the resource's own ACL arrays (the same seven arrays
`/app/resource/get` returns). `/app/resource/update` is the endpoint
that WRITES them — there is no separate resource-ACL route. Omitted =
preserve (COALESCE-skip); an empty array clears the bucket. Role tids
are bracket-wrapped (`[r-…]`) before persistence.

These arrays gate **almost** every `/app/doc/*` op on that resource —
`list`, `get`, `create`, `update`, `del`, `upsert`, `create-batch` and
`import`. Denial is deliberately asymmetric: **`/app/doc/list` returns
an empty success page** (no existence leak), while the rest return
`access_denied`. Doc create/update/delete additionally require the
resource's `editors` / `deletable`.

> **`/app/doc/acl-set` is the exception: it does not consult the
> resource ACL at all.** Its gate is app-level Editor plus the doc's own
> ACL (owner/manager or the doc's author) — the resource layer is not in
> the path.
>
> So a caller excluded by a resource's `noaccess`, or simply absent from
> a restrictive `editors`, is refused `update` and `del` on a document
> and can still rewrite that document's per-doc ACL — including adding
> themselves to its `editors`. Reaching it requires app-level Editor and
> either app owner/manager standing or authorship of the doc, so this is
> not an anonymous hole; but it does mean **the resource ACL is not a
> complete containment boundary for a doc's permissions.** If you are
> using resource-level `noaccess` to fence a group away from a class of
> records, that fence does not cover per-doc ACL edits.

`managers / designers / authors` are read back by
`/app/resource/get` (owner/manager only) but have **no API write path at
all** — neither create nor update accepts them.
See [acl-model.md](acl-model.md) for the layered model.

### POST /app/resource/del

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`.

Soft-deletes the resource, then reclaims its stored docs. Refused with
`resource_referenced_by_link` while another live resource has a
`link`/`multilink` field pointing at this one. If the storage reclaim
fails the request still succeeds and the resource shows up under
`orphans` in `/app/resource/constraints`.

### POST /app/resource/constraints

**Auth:** Editor on `app_tid` (the response exposes roster sizes and
storage identifiers). Rate-limited per tenant — a burst answers **429**
`rate_limit_exceeded` with `Retry-After`.

**Body:** `{app_tid}`.

**Response `data`:**
- `resources[]` — per resource (max 500): `tid, ma, name, description,
  doc_count, share_count, hook_count, field_count, acl_user_count,
  acl_breakdown:{managers,designers,authors,editors,readers,deletable,noaccess},
  storage_table, updated_at, sharing, status, flags[]`. `flags` ∈
  `empty` (no docs), `stale` (has docs, untouched for 30 days),
  `no_acl` (nobody rostered).
- `orphans[]` — soft-deleted resources whose rows were never reclaimed:
  `{tid, name, doc_count, storage_table}`.

### POST /app/resource/orphan-drop

**Auth:** Manager on `app_tid`. **Body:** `{app_tid, tid}`.

Finishes the interrupted reclaim for **one already-soft-deleted**
resource. Idempotent. Refuses outright on a live resource
(`resource_not_deleted`). Returns `{data:{dropped_rows}}`.

---

## Docs (data rows)

### POST /app/doc/list

**Auth:** Reader on `app_tid`.

**Body:**
```json
{
  "app_tid":         "a-xxx",   required
  "resource_tid":    "r-xxx",   one of resource_tid|resource_ma required
  "resource_ma":     "student",
  "include_deleted": false,     optional
  "author":          "u-xxx",   optional filter
  "where":           { "grade": "7A" },   optional, see Filter DSL below
  "limit":           100,       optional, clamp 1..=500, default 100
  "offset":          0,         optional, max 100000 — see paging
  "cursor":          "1735689600000|d-xxx"   optional keyset cursor
}
```

**Paging.** Two modes:

- **Offset** — simple, but bounded. An `offset` beyond 100 000 is
  **rejected** (`offset_too_deep`) rather than silently clamped, so you
  never receive the wrong page believing it is the one you asked for.
- **Keyset (preferred for deep paging)** — a successful page whose rows
  may be followed by more carries `next_cursor` at the top level. Pass it
  back as `cursor` for the next page. When `cursor` is set, `offset` is
  ignored. A malformed cursor is `cursor_invalid`, never a silent reset
  to page 1.

**Filter DSL:** `where` is a flat map of `key: value` AND'd
together. Allowed:

- **Key constraints:** must match `[a-z_][a-z0-9_]*`. Cap 10 keys per
  call. A key **not declared** in the schema is accepted and treated as
  level 0 — a typo returns zero rows rather than an error. Only keys
  explicitly declared at `level >= 1` are rejected.
- **Value types:** string / number / boolean → equality. Array →
  IN semantics.
- **Rejected with codes:** `cannot_filter_encrypted_field` (key declared
  level ≥ 1), `cannot_filter_nested` (object value), `where_invalid_key`
  (identifier-regex mismatch), `where_too_many_keys` (>10),
  `where_empty_array` (`[]`), `where_invalid_array_value` (non-scalar
  array element), `where_null_value` (`null`).
- Omitting `where` returns everything the caller may see.
- **Reserved for a later version** (not implemented): operator-aware
  values `{ "op": "gt", "value": 5 }` and logical groups
  `{ "$and": [...], "$or": [...] }`.

**Response:** `data` is an array of doc rows; encrypted (level ≥ 1)
fields are decrypted back into the unified `data` object of each row when
the caller may access the app key. `next_cursor` accompanies a page that
may have a successor. A `meta` block appears when [row-level
scope](#row-level-scope-req-tfl5-006) is active. Resource-not-found
returns `{"result":false,"code":"resource_not_found"}`.

#### One unopenable cell fails the whole read

Decryption of a `level: 1|2` field has **no per-row and no per-field
fallback**. Any failure — a ciphertext this cell's key cannot open, a
malformed envelope, a value that no longer deserialises — becomes a
server fault, and it propagates straight out of the row loop. So a single
bad cell aborts the **entire** response with HTTP **500**
`{"code":"internal"}`, taking with it every unrelated row on the same
page. On a 100-row page, ninety-nine readable rows are lost to the
hundredth.

This applies to `/app/doc/list` and `/app/doc/get` alike, and it is the
shape you should expect during a master-key rotation or after a restore
that brought back rows without their key.

**Do not assume symmetry with account PII.** The `/user/profile` PII
path degrades *gracefully* — an unreadable field comes back `null` and
is named in [`unreadable[]`](#post-userprofile), and the rest of the
response is served. Doc-field encryption does the opposite: it fails
closed on the whole request. Two different subsystems, two different
answers to the same underlying condition.

Practical consequences:

- Treat `level >= 1` as a per-resource decision with a blast radius of
  the whole listing, not a per-field one.
- A 500 from `/app/doc/list` on a resource that has encrypted fields is
  more likely a key problem than a query problem; narrow it by paging
  with a smaller `limit` (or `cursor`) until you isolate the row.
- There is no request flag to skip, null out, or tolerate an unopenable
  cell.

### POST /app/doc/create-batch

**Auth:** Editor on `app_tid`.

**Body:**
```json
{
  "app_tid":      "a-xxx",                        required
  "resource_tid": "r-xxx",                        one of *_tid|*_ma required
  "resource_ma":  "attendance",
  "items": [                                       required, 1..=200
    {
      "data":      { ... },                       optional, defaults {}
      "editors":   ["..."], "readers": ["..."],
      "deletable": ["..."], "noaccess": ["..."]
    },
    ...
  ],
  "atomic": true                                   optional, default true
}
```

**Cap:** `items.length` must be 1..=200. `>200` → `batch_too_large`; an
empty array → `batch_empty`. Both are HTTP 400.

**Atomic mode (`atomic: true`, default):**
- All `before_create` hooks run per-item BEFORE the TX opens. If any
  item fails its hook, the entire batch aborts; nothing is inserted.
- A single transaction inserts all items.
- `after_create` hooks fire per-item POST-commit (best-effort, logged
  to `hook_invocations`).
- Response: `{result: true, data: {tids: [...], count: N}}`.

**Best-effort mode (`atomic: false`):**
- Each item runs its own micro-flow. Successes are kept; failures
  are collected.
- Response: `{result: true, data: {tids: [<successes>], count: <success_count>, failures: [{ "index": 2, "code": "...", "msg": "..." }, ...]}}`.
  The `failures` key is **omitted entirely** when nothing failed.

**Side effects:**
- 1 audit_log row per batch (NOT per-doc) with count + failure summary.
- `hook_invocations` rows per row's `after_create` hooks (as usual).
- Field-level encryption applied per item (level 1/2 → `data_secret`).

### POST /app/doc/upsert

**Auth:** Editor on `app_tid`. Per-row ACL is **not** consulted on the
update branch — see "trade-off" below.

**Body:**
```json
{
  "app_tid":      "a-xxx",                              required
  "resource_tid": "r-xxx",                              one of *_tid|*_ma required
  "resource_ma":  "attendance",
  "match_on":     { "student_id": "s-001",
                    "date_iso":   "2026-06-01" },       required, 1..=5 keys
  "data":         { "status": "present", ... },         optional, see auto-merge
  "editors":      ["..."], "readers": ["..."],
  "deletable":    ["..."], "noaccess": ["..."]          create-branch only
}
```

**Semantics — INSERT-or-UPDATE in one transaction:**

The server runs `SELECT ... WHERE data_indexed @> $match_on::JSONB LIMIT 2`
inside a TX, then branches:
- **0 matches → CREATE.** Generates `d-<uuid>`, applies caller-supplied
  ACL arrays, fires `before_create` + (post-commit) `after_create` hooks,
  audit row `doc.upsert.create`.
- **1 match → UPDATE.** Patches `data_indexed` / `data_secret` /
  `updated_at` only. **ACL arrays are preserved** (caller's `editors`/
  `readers`/`deletable`/`noaccess` ignored on this branch — patch ACL
  separately via `/app/doc/acl-set`). Fires `before_update` +
  (post-commit) `after_update` hooks, audit row `doc.upsert.update`.
- **≥2 matches → abort with `match_on_ambiguous`.** Upsert requires a
  unique key; for non-unique flows use `/app/doc/list` + `/app/doc/update`.

**`match_on` constraints:**

- 1..=5 keys; same identifier regex as `/app/doc/list` (`[a-z_][a-z0-9_]*`).
- Values must be string / number / boolean (no arrays, no objects, no
  null). Encrypted fields (`level: 1` or `2`) rejected with
  `cannot_filter_encrypted_field`. Unknown keys default to `level: 0`.
- Keys are **auto-merged into `data`**. If `data` already has the key
  with a different value → `match_on_data_mismatch`.

**Trade-off:** because the row may not exist yet, per-row ACL cannot be
consulted up-front. App-level Editor is therefore the only gate. If your
resource needs stricter per-row write protection on update, model it via
hooks (`before_update` can reject) or use `/app/doc/update` directly
after a `list` lookup.

**Response:**
```json
{
  "result": true,
  "data": { "tid": "d-xxx", "created": true|false, "resource_tid": "r-xxx" },
  "timestamp": 1735689600000
}
```

**Error codes:** `match_on_required`, `match_on_too_many_keys`,
`match_on_invalid_key`, `match_on_invalid_value`,
`cannot_filter_encrypted_field`, `match_on_data_mismatch`,
`match_on_ambiguous`, `resource_not_found`.

### POST /app/doc/get

**Auth:** Reader on `app_tid`. Body: `{app_tid, tid}`. Returns
`{tid, resource_tid, data, author, editors, readers, deletable,
noaccess, deleted_at, created_at, updated_at}`. Missing → `not_found`.

Encrypted (`level >= 1`) fields are decrypted into `data` on the way
out, on the same all-or-nothing footing as `/app/doc/list` — see
[One unopenable cell fails the whole read](#one-unopenable-cell-fails-the-whole-read).

**Break-glass header.** When the caller's [scope](#row-level-scope-req-tfl5-006)
binding is aggregate-level, reading an individual row is refused with
`pii_aggregate_only` unless the request carries an `X-Audit-Reason`
header stating why — the reason is recorded.

### POST /app/doc/create

**Auth:** Editor on `app_tid` (app-level Editor; the new doc inherits
app-level ACL since it has no per-doc ACL yet — author becomes the
caller).

**Body:**
```json
{
  "app_tid":      "a-xxx",                   required
  "resource_tid": "r-xxx",                   one of *_tid|*_ma required
  "resource_ma":  "student",
  "data":         { ... },                   defaults {}
  "editors":      ["..."],                   optional, defaults []
  "readers":      ["..."],                   optional
  "deletable":    ["..."],                   optional
  "noaccess":     ["..."]                    optional
}
```

**Response (success):**
```json
{ "result": true,
  "data": { "tid": "d-...", "resource_tid": "r-..." },
  "timestamp": ... }
```

**Side effects:**
- `before_create` + `after_create` hooks fire (see hooks logic).
  `require_fields` hook failure → `hook_validation_failed`.
- Field-level encryption: keys declared `level >= 1` in the resource
  schema are stored encrypted in a separate column, bound to the doc tid
  and the field name so a ciphertext cannot be replayed into another
  row or another field.
- May write a `hook_invocations` row for declared webhook fanout.

### POST /app/doc/update

**Auth:** Editor on app, applied through `require_doc_perm` so per-doc
ACL also gates. Body shape: `{app_tid, tid, data?, editors?, readers?,
deletable?, noaccess?}`. Omitted `data` preserves both columns. Fires
`before_update` + `after_update` hooks. Not-found → `{"msg":"Doc not
found or already deleted","code":"not_found"}`.

### POST /app/doc/del

**Auth:** Editor on app + `doc.is_deletable_by(caller)` (app
owner/manager, doc author, or row.deletable member).

**Body:** `{app_tid, tid}`. Soft delete; fires `before_del` +
`after_del` hooks.

### POST /app/doc/acl-set

**Auth:** Editor on app + (owner/manager OR doc author).

**Body:** `{app_tid, tid, editors?, readers?, deletable?, noaccess?}`.
COALESCE-skip semantics.

**Response `data`:** `{tid, acl_updated: true}` — and nothing else.
Unlike [`/app/file/acl-set`](#post-appfileacl-set), this endpoint does
**not** echo the resulting arrays, even though it applies the same
bracket normalisation on the way in. So a caller cannot see what was
actually stored from the reply.

If you need the post-write state — and you do, if you are rendering it —
follow with [`/app/doc/get`](#post-appdocget), which returns the doc's
`editors`/`readers`/`deletable`/`noaccess`. Do not assume the stored
arrays equal the ones you submitted: a bare `r-…` is stored as `[r-…]`.

### POST /app/doc/import-preview  *(multipart)*

**Auth:** Editor on `app_tid`. Read-only — nothing is written, no hooks
run.

**Multipart fields:** `app_tid` (text), `file` (binary — `.csv` or
`.xlsx`; the format is detected from the filename, falling back to
content sniffing). Max 20 MB.

Reads the first sheet, treats row 1 as headers, samples up to 200 rows,
and proposes a schema.

**Response `data`:**
- `fields[]` — `{field, name, validator}` in exactly the shape
  `/app/resource/create` accepts.
- `mapping` — `{"<header>": "<field key>"}`, to feed straight back into
  `/app/doc/import`.
- `sampled`, `total` — rows inspected vs rows in the file.

Inference is deliberately conservative: a validator (`number`, `date`,
`datetime`, `email`, or `choice:a|b|…` when a column has ≤ 8 distinct
values) is only proposed when **every** sampled non-empty value fits;
otherwise the column is free text.

### POST /app/doc/import  *(multipart)*

**Auth:** Editor on `app_tid` **and** Editor on the target resource's own
ACL.

**Multipart fields:** `app_tid` (text), one of `resource_tid` /
`resource_ma` (text), `file` (binary — `.csv` or `.xlsx`), `mapping`
(text, JSON object `{"<header>":"<field>"}`), `atomic` (text `"true"`;
anything else = best-effort, the default).

**Caps:** 20 MB per upload (`file_too_large`), 5 000 rows
(`import_too_large`).

**Semantics.** Rows are pushed through the same pipeline as
`/app/doc/create-batch` in chunks of 200 — same validation, hooks, link
integrity, scope and field encryption as a hand-written create. This
means `atomic: true` is **per chunk of 200**, not across the whole file:
a 5 000-row atomic import is 25 all-or-nothing transactions.

**Response `data`:** `{tids[], count, requested}`, plus `failures[]` when
any row was rejected. Each failure carries a 1-based `row` number that
counts the header row, so it lines up with what the user sees in their
spreadsheet.

**Codes:** `csv_invalid`, `xlsx_invalid`, `xlsx_empty`,
`mapping_invalid`, `file_too_large`, `import_too_large`,
`resource_not_found`, plus any per-row code the create pipeline raises.

### Row-level scope (REQ-TFL5-006)

On top of the per-doc/per-resource ACL arrays, `/app/doc/*` supports a
tenant-configured **row-level scope filter**: "the caller only sees
rows whose column X ∈ their allowed set". It is domain-neutral (a code
`S` can mean "company", "school", or anything) and configured purely
with data — no new schema, no new code. The config lives in the app's
`apps.acls.scope` JSONB blob as two keys:

- **`field_map`** — per `resource_ma`, maps scope codes (`G/W/S/C/M/O/N`)
  to the doc column they filter on (plus `own_param` for own-records).
- **`bindings`** — per `user_tid`, a list of
  `{ scope, params, role_code, pii_level? }` grants. Multi-role users
  get their bindings UNION'd (OR).

**Enforcement is gated by three layers, all must be true (default OFF):**

1. Env flag `TFL5_ENFORCE_SCOPE=true` — global circuit breaker; unset =
   bypass entirely (ships dark).
2. Per-app opt-in — `apps.acls.scope.field_map` non-empty.
3. Requested resource has an entry in `field_map` — otherwise
   default-deny (`scope_not_configured`, 400).

When active on `/app/doc/list`, the scope predicate is AND'd into the
SQL alongside any client `where` filter; a user with no matching
bindings gets zero rows. The response carries a
`meta.scope_filter_applied` object (and `meta.pii_aggregate_dropped`
when PII-masking drops rows). The synthetic `_cluster` user bypasses
scope. See [acl-model.md](acl-model.md) for how scope layers with the
ACL arrays.

### POST /app/scope/get

**Auth:** Designer on `app_tid` (scope config is operator-tier).

**Body:** `{app_tid}`.

**Response:**
```json
{
  "result": true,
  "app_tid": "a-xxx",
  "field_map":   { ... },   // apps.acls.scope.field_map verbatim
  "my_bindings": [ ... ],   // ONLY the caller's own bindings
  "timestamp": 0
}
```
Designer callers see the full `field_map` (operator config, no PII) but
only their OWN `bindings` entry, mirroring `/user.scope_bindings`.
Unset scope returns `{field_map: {}, my_bindings: []}`.

### POST /app/scope/set

**Auth:** Designer on `app_tid`.

**Body:** three optional patch modes, applied in order (`field_map`,
then `bindings` replace, then `bindings_patch`):
```json
{
  "app_tid":         "a-xxx",                 required
  "field_map?":      { "<resource_ma>": { ... } },  // object=replace, null=clear
  "bindings?":       { "<user_tid>": [ {scope,params,role_code,pii_level?} ] },
                                                     // object=replace ALL, null=clear
  "bindings_patch?": { "<user_tid>": [ ... ] }       // per-user: array=set, null=delete
}
```

**Validation:** `field_map` must be object or null
(`scope_field_map_invalid`); `bindings` must be object or null
(`scope_bindings_invalid`); `bindings_patch` must be an object whose
values are each an array or null
(`scope_bindings_patch_invalid` / `…_value`). `bindings_patch` lets an
idempotent sync update one user at a time without shipping the whole
map.

**Response:** `{result: true, data: {app_tid, bindings_count,
field_map_size}, timestamp}` — the post-write counts, so an idempotent
sync can sanity-check without a `/app/scope/get` round-trip.

**Propagation caveat:** unlike `/app/acl-set`, this endpoint does **not**
invalidate the per-app permission cache. A scope change can therefore
take up to the cache TTL to be observed by an in-flight session. Do not
treat it as an instant kill-switch.

---

## Publishing a frontend

Three mechanisms can put bytes behind your app's domain. They are not
alternatives you must choose between blindly — at serve time the platform
resolves a request in a **fixed precedence order**:

1. **Site snapshot** — if the app has a published snapshot
   (`/app/site/publish`), the request resolves through it.
2. **Bundle** — else, if a bundle version is activated
   (`/app/bundle/activate`), the request resolves inside that version.
3. **File tree** — else, the app's `release`-stage files
   (`/app/file/*` + `/app/release`).

An app that never touches the newer layers keeps serving from the file
tree exactly as before, so all three remain supported.

Which to use:

| You are… | Use |
|---|---|
| shipping a pre-built SPA / static site from CI | **Bundles** — one versioned zip, atomic activate, instant rollback |
| authoring pages in-product (visual/no-code editor) | **Site engine** — draft → preview → publish, per-file history |
| managing individual assets with per-file ACL, signed URLs, trash | **Files** |

Quota accounting and the trash belong to Files alone. **Per-file ACL is
not so simple**, and getting it wrong is a disclosure bug:

- **Bundles are public by contract.** Bundle entries carry no per-file
  ACL and none is consulted. A bundle *is* the front-end a tenant ships
  to its users, so a non-default ACL belongs on user-uploaded data, not
  on app code. Do not put anything private in a bundle.
- **Snapshots are not public.** The snapshot tier enforces the `files`
  row ACL for the path being served, exactly as the file and
  object-storage tiers do. It has to: the snapshot tier has the
  *highest* priority, so an ACL it skipped would be an ACL that
  publishing silently removed.
- **Files** enforce it as always.

**The snapshot check reads the ACL live, not a copy frozen at publish
time.** Two consequences worth relying on: revoking someone's access
takes effect immediately, with no republish; and rolling back to an
older snapshot still honours **today's** ACL rather than the one that
was in force when that snapshot was made. A denial is served as a 404,
not a 403 — the same non-disclosure the rest of the platform uses.

One gap to know about: an entry still present in a snapshot whose
underlying `files` row has since been deleted falls back to the legacy
"no row, allow" rule and is served. Delete the bytes, not just the row,
if the content is sensitive.

### Site engine (draft → publish)

Content-addressed. Writes land in a mutable **draft**; `publish` freezes
the draft into an immutable **snapshot** and flips the app's live
pointer in one atomic step. Every endpoint is **Manager** on `app_tid`.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /app/site/put` | `{app_tid, path, kind?, content_text?, content_base64?, mime?}` | writes into the draft. `kind` is `file` (default use) or `page` (a JSON component tree). Exactly one of `content_text` / `content_base64`. Per-file cap **50 MiB (52,428,800 B) on the decoded bytes** — both input shapes go through the one gate; over it, `file_too_large` whose `msg` names the path *and* both sizes. Body layer above it: 74,099,372 B (base64 of a maximal file plus 4 MiB of envelope). Returns `{snapshot_id, blob_sha, size, deduped}` |
| `POST /app/site/delete` | `{app_tid, path}` | `{removed}` |
| `POST /app/site/list` | `{app_tid}` | `{entries}` — the draft |
| `POST /app/site/get` | `{app_tid, path}` | `{found, content_base64}` |
| `GET /app/site/preview` | query `?app_tid=…&path=…` (`path` defaults to `index.html`) | renders/serves the **draft**; `page` entries are rendered to HTML, files streamed with their stored type and `Cache-Control: no-store`. Not a JSON envelope |
| `POST /app/site/publish` | `{app_tid, note?}` | `{live_snapshot}`. An empty draft is refused ("nothing to publish") |
| `POST /app/site/rollback` | `{app_tid, snapshot_id}` | re-points live at an earlier snapshot — see below |
| `POST /app/site/history` | `{app_tid}` | `{snapshots}` |
| `POST /app/site/file-history` | `{app_tid, path}` | `{versions}` — every version of one path |
| `POST /app/site/blob` | `{app_tid, sha}` | `{found, content_base64}` — fetch by content hash |
| `POST /app/site/backfill` | `{app_tid}` | one-shot import of an existing file tree into a first snapshot — see below |

Blobs are content-addressed and reference-counted, so re-publishing an
unchanged file costs nothing (`deduped: true`).

**`rollback` cannot target the app's own draft.** The draft is the
working tree, not a published version; making it live would put
unreviewed content in front of visitors, and worse, every subsequent
save into the draft would change the live site the moment it was saved,
because the pointer and the working tree would be the same snapshot.
The attempt is refused **400** — a generic `bad_request`, with no
dedicated code, so match on the status and read `msg`, which names
`/app/site/publish` (turn the draft into a version) and
`/app/site/history` (pick an existing one) as the two ways forward. A
database constraint enforces the same invariant underneath, so it cannot
be reached by any other route either.

**Rollback never clears the live pointer.** No route in the platform
sets `live_snapshot` back to null — publish, rollback and backfill all
re-point it at some snapshot. So rolling back cannot "switch the site
engine off" and fall through to the bundle or file tiers; once an app
has published a snapshot, the snapshot tier keeps winning. If you need
the lower tiers back, that is an operator action, not an API call.

**`backfill` is all-or-nothing, and it will tell you when it did
nothing.** Response:
`{result, imported, snapshot_id, reason, file_count, truncated, skipped}`
— `imported` is a boolean, and `reason` is one of:

| `reason` | Meaning |
|---|---|
| `already_on_engine` | the app already has a snapshot; nothing to import |
| `no_files` | the source tree was empty |
| `too_many_files` | the tree is larger than one import may copy |

The cap is 5000 files by default (`TFL5_BACKFILL_MAX_FILES`). **Over the
cap, nothing at all is written** — no blobs, no snapshot row, no pointer
flip — and `truncated` comes back true. A partial copy is deliberately
not offered, because a partial copy would have gone live as the whole
site.

`skipped[]` names paths whose bytes could not be read. They are **not in
the snapshot and will not be served**, so a backfill that reports
`imported: true` with a non-empty `skipped` is a site with holes in it —
check the array before you consider the migration done.

### Bundles (versioned static releases)

A bundle is one immutable version of your whole static asset tree.
Bundle bytes do **not** count against the tenant's storage quota, and
bundle entries carry no per-file ACL — they are public.

### POST /app/bundle/upload  *(multipart)*

**Auth:** Manager on `app_tid`.

**Multipart fields:** `app_tid`, `version` (required, unique per app,
alphanumeric plus `. _ -`, ≤ 64 chars), `notes` (optional), `file` (one
`.zip`).

**Caps:** zip ≤ 50 MiB (52,428,800 B); ≤ 500 entries; ≤ 100 MiB
(104,857,600 B) uncompressed; each individual entry also ≤ 50 MiB
(52,428,800 B); every entry must pass the extension allowlist. An
oversize zip is refused by the handler with `file_too_large`, and the
message names both numbers — the size you sent and the cap.

Above that handler sits a **body layer of 52 MiB (54,525,952 B)** — the
50 MiB file cap plus 2 MiB of multipart envelope. A request larger than
*that* never reaches the zip check at all: it answers
`upload_request_too_large`, a size refusal naming the body cap, **not** a
parse error. So `bundle_too_large` / `file_too_large` mean "the zip is
too big", while `upload_request_too_large` means "the HTTP request is
too big" — two different limits, two different codes.

**Response `data`:** `{tid, app_tid, version, sha256, file_count,
total_bytes, uploaded_at, original_filename}`.

**Codes:** `bundle_version_invalid`, `bundle_version_exists`,
`bundle_invalid_zip`, `bundle_too_many_entries`, `bundle_too_large`,
`bundle_decompress_failed`, `file_too_large`,
`upload_request_too_large`, `file_extension_not_allowed`.

Uploading does **not** publish — the version is stored inert.

### POST /app/bundle/activate

**Auth:** Manager. **Body:** `{app_tid, version}`. Atomically flips the
app to that version and remembers the previous one. Returns
`{app_tid, current_bundle_version, previous_bundle_version}`.
`bundle_version_not_found` if the version was never uploaded.

### POST /app/bundle/rollback

**Auth:** Manager. **Body:** `{app_tid}`. Swaps current ↔ previous in one
step. `bundle_no_previous` when there is nothing to go back to.

### POST /app/bundle/unpublish

**Auth:** Manager. **Body:** `{app_tid}`. Clears the active version —
takes the site offline. Idempotent. `app_not_found` if the app is gone.

### POST /app/bundle/delete

**Auth:** Manager. **Body:** `{app_tid, version}`. Permanently removes
one stored version and its bytes.

**Response `data`:** `{app_tid, version, files_removed, bytes_freed}`.
`bytes_freed` is the size recorded on the version row, not a fresh
measurement of what was deleted. Writes a `bundle.delete` audit row.

**Refusals** (all **400**):

| Code | When |
|---|---|
| `bundle_is_live` | the version is the app's current one — unpublish or activate another first |
| `bundle_is_rollback_target` | the version is the app's `previous_bundle_version`, i.e. what `/rollback` would go back to |
| `bundle_not_found` | no such version for this app |
| `app_not_found` | the app row is gone |

The two guards exist so a delete cannot take the site offline and cannot
quietly disarm rollback. Nothing is refused for being merely old.

**Storage is deleted first, the row second.** An interruption between
the two therefore leaves a row pointing at bytes that are gone rather
than orphaned bytes nothing references — retry the same call to finish.
Do not treat a repeated `bundle_not_found` after a failed delete as a
lost version.

### POST /app/bundle/list

**Auth:** **Reader** on `app_tid` (the only bundle endpoint below
Manager). **Body:** `{app_tid, limit?}` (default 20, clamp 1..=200).
Returns each version with `{tid, version, sha256, file_count,
total_bytes, uploaded_by, uploaded_at, notes, is_current, is_previous}`
plus the app's `current_bundle_version` / `previous_bundle_version`.

---

## Files (binary + static)

Files live in two stages — `release` (live) and `test` (staging).

### POST /app/file/upload  *(multipart)*

**Auth:** Editor on `app_tid`.

**Multipart fields:**
- `app_tid` — text, required.
- `stage` — text, optional (defaults to the **test** stage for writes).
- `path` — text, optional; defaults to the uploaded file's name. Sent
  BEFORE the corresponding `file` part.
- `file` — binary, repeatable for batched upload.
- `bundle` — text `"1"|"true"|"yes"`, optional: treat the single
  uploaded `.zip` as a tree to unpack server-side. Requires exactly one
  `file` part (`bundle_requires_single_zip`) and applies the same
  500-entry / 100 MiB-uncompressed (104,857,600 B) / 50 MiB-per-entry
  (52,428,800 B) caps as `/app/bundle/upload`. The entry cap and the
  running uncompressed total are separate checks: one 60 MiB entry is
  refused `file_too_large`, while many small entries summing past
  104,857,600 B are refused `bundle_too_large`.
- `bundle_prefix`, `scope_attrs` — optional.

**Limits:** 50 MiB (52,428,800 B) per file, request body up to 100 MiB
(104,857,600 B). Extension allowlist: HTML/CSS/JS/JSON, common images,
fonts, plain text. Banned ext → `file_extension_not_allowed`. A single
oversize file → `file_too_large`.

The two numbers together decide what a *batch* may contain, and the
constant records the arithmetic: **one 50 MiB file per request fits**,
with room left for the multipart envelope; **two do not**; hundreds of
ordinary assets are unaffected. An over-cap batch is refused **by size**,
with `upload_request_too_large` naming the body cap — not as a parse
failure, and not as `file_too_large`, because no individual file broke
its own limit. Because each field is buffered whole, that refusal fires
while reading the part, before the per-file check runs.

> **Stage defaults are asymmetric, and the split is narrower than it
> looks.** Only the two byte-writing calls — `/app/file/upload` and
> `/app/file/save` — default to **`test`**, so one forgotten field can't
> overwrite the live site.
>
> **Every other call defaults to `release`, including the destructive
> ones.** `del`, `rename`, `acl-set` and `folder/create` mutate, but they
> take the read-side default: omit `stage` on a delete and you delete
> from the **live** site. Always pass `stage` explicitly on anything that
> changes state.
>
> An operator can close that asymmetry with
> **`TFL5_STRICT_WRITE_STAGE=1`**, which makes those four ops default to
> `test` as well. It is **off** by default, so do not rely on it — pass
> `stage` yourself and your client behaves the same on every cell.

#### `warnings[]` — your write may not be what visitors see

Four routes — `/app/file/upload`, `/app/file/save`, `/app/file/del` and
`/app/file/rename` — can return an **additive top-level `warnings`
array** beside the usual payload:

```json
{ "result": true, "data": [ … ],
  "warnings": [ { "code": "file_write_shadowed_by_snapshot",
                  "msg": "…", "live_snapshot": "<snapshot id>" } ],
  "timestamp": 1700000000000 }
```

It appears when the write targeted `stage=release` **and** the app is
serving a published [site snapshot](#site-engine-draft--publish). The
write succeeded and the bytes are stored — but the snapshot tier
out-ranks the file tree in the [serve
order](#publishing-a-frontend), so **visitors will not see the change**
until the app publishes again or the snapshot is cleared. Silence here
is the dangerous case: without the warning, a successful-looking write
that changes nothing on the live site is indistinguishable from one that
works.

The key is **omitted entirely** when there is nothing to report — treat
its absence as "no warnings", not as an older server.

An operator can turn the same condition into a hard failure with
**`TFL5_REFUSE_SHADOWED_FILE_WRITE=1`**, in which case the write is
refused **409** with that same `file_write_shadowed_by_snapshot` code
and `data: {live_snapshot}` instead of succeeding with a warning. So one
code covers both a warning and a refusal — branch on the status, not on
the code alone.

`/app/file/acl-set` and `/app/folder/create` do **not** carry
`warnings`, even though the strict-stage flag above does apply to them.

**Quota:** release-stage uploads are charged against both the app's
storage cap and the owner's total-storage cap. Overshoot →
`quota_app_max_storage`. The test stage has its own per-app cap.

**Response data:** array of `{tid, path, stage, size, mime,
parent_tid, original}` per uploaded file.

**Side effects:** the first write to a fresh test stage clones the
release stage in first.

### POST /app/file/save

**Auth:** Editor on `app_tid` (JSON-body alternative to multipart).

**Body:**
```json
{
  "app_tid":        "a-xxx",                 required
  "path":           "index.html",            required
  "content_base64": "...",                   required; standard or url-safe,
                                             padded or not, whitespace ok
  "mime":           "text/html",             optional override
  "stage":          "release" | "test",      optional, default "test"
  "scope_attrs":    { ... }                  optional
}
```

Same 50 MiB (52,428,800 B) per-file cap and extension gate as `/upload`,
checked on the **decoded** bytes. One file per call.

**Request body cap: 74,099,368 B (~70.7 MiB)** — not a round number
because it is derived rather than chosen: base64 costs 4/3, so a 50 MiB
file arrives as ~69.9 MB of text, plus 4 MiB of slack for the rest of the
JSON envelope. The old 20 MB figure was smaller than a maximal file's own
encoding, which meant the handler's 50 MiB check could never fire — every
large save died at the body layer instead, with the wrong code.

### POST /app/file/get

**Auth:** Reader on `app_tid` + per-row ACL. Request body up to 1 MB.

**Body:** `{app_tid, path, stage?}` (`stage` defaults to `release`).

**Response data:** `{tid, path, stage, size, mime, content_base64}`.

**The read cap is 10 MiB (10,485,760 B) — a different number from the
50 MiB you may write.** A file over it returns HTTP 200 with
`{"result":false, "code":"file_too_large",
"data":{path,size,mime,tid,max_bytes}}` — fetch those through
`/app/file/sign-url` or the public URL instead. So a perfectly legal
upload can be unreadable through this endpoint; `data.max_bytes` is the
authoritative read cap, and it is not the upload cap. A file the caller may
list but not read at full fidelity under PII scoping returns
`pii_aggregate_only`.

### POST /app/file/list

**Auth:** Reader on `app_tid`. Body: `{app_tid, stage?}`. Returns
files + folders for the given stage; per-row ACL filters out rows the
caller can't see (owner/manager bypass).

### POST /app/file/del

**Auth:** Editor on `app_tid` + per-row `deletable` (owner/manager
bypass).

**Body:** `{app_tid, path, recursive?: false, stage?}`. Folder delete
needs `recursive: true` when non-empty (else HTTP 200 +
`{"result":false,"code":"folder_not_empty","item_count":<n>}`). The
refusal now carries `item_count` as a top-level field **and** names the
same count in `msg`, so a confirmation dialog can say how much is about
to go without a second round-trip. The count excludes the folder's own
row — it is what `recursive: true` would delete. Soft-delete — the bytes
move to trash and still count against quota until purged.
Returns `{freed, is_dir, tid, trashed_at}`.

### POST /app/file/acl-set

**Auth:** Manager on `app_tid`.

**Body:**
```json
{ "app_tid", "path", "managers": [], "editors": [], "readers": [],
  "deletable": [], "noaccess": [], "stage": "release" }
```
Every array field defaults to `[]` (replace; omitted=clear). 404 if
no row.

**Response `data`:** `{path, managers, editors, readers, deletable,
noaccess}` — and those arrays are **what was stored, not what you
sent**. Normalisation happens on the way in: a bare `r-…` comes back
bracket-wrapped as `[r-…]`, and blank entries are gone. Echoing your
input back would assert it had been kept verbatim when it had not, so
the handler returns the stored truth instead. **Use the response to
refresh your local state**; re-rendering from the request will drift
from the server on the first role tid anyone types unbracketed.

Note the asymmetry with the per-doc equivalent below: this endpoint
echoes, `/app/doc/acl-set` does not.

### POST /app/file/rename

**Auth:** Editor + per-row `deletable` (rename treated as move).

**Body:** `{app_tid, path, new_path, stage?}`. File only (folders
rejected). Preserves `tid` + ACL. Destination extension must pass
allowlist. Conflict at destination → BadRequest.

### POST /app/file/trash-list

**Auth:** Editor on `app_tid`. Body: `{app_tid, stage?}`. Returns
trashed rows (`deleted_at IS NOT NULL`) across both stages when
`stage` omitted.

### POST /app/file/restore

**Auth:** Editor on `app_tid` + same row-ACL guard as `/del`.

**Body:** `{app_tid, file_tid, new_path?}`. `new_path` only supported
for files. Conflict at target → BadRequest.

### POST /app/file/purge

**Auth:** Manager on `app_tid` (irreversible, regardless of who owned the
row). Body: `{app_tid, file_tid}`. Removes the row and the trashed bytes
— and is the **only** point at which the storage quota is credited back.
Returns `{tid, purged_size, is_dir}`.

### POST /app/file/sign-url

**Auth:** Reader on `app_tid` + per-row ACL.

**Body:** `{app_tid, path, stage?, expires_in_sec?}`. TTL clamped
server-side.

**Response data:** `{signed_url:"/_signed/<token>", expires_at,
cache_seconds}`. The token is HMAC over
`(app_tid, path, stage, expires_at, user_tid)`.

### GET /_signed/:token

**Auth:** None — the URL **is** the grant. Serves the bytes with
`Cache-Control: public, max-age=<cache_seconds>`. Errors: `410 gone`
(expired, `signed_url_expired`), `403` (`signed_url_invalid`), `404`
(`not_found`).

### POST /app/folder/create

**Auth:** Editor on `app_tid`. Body: `{app_tid, path, stage?}`.
Idempotent (INSERT ... ON CONFLICT DO NOTHING). Creates the folder
on disk too.

---

## Stages (test vs release)

### POST /app/test/status

**Auth:** Reader on `app_tid`. Body: `{app_tid}`.

**Response data:** `{used_storage, cap, last_activity_at, idle_for_ms,
auto_delete_at, swept_at, ttl_ms}` for the test stage.

### POST /app/test/wipe

**Auth:** Manager on `app_tid`. Body: `{app_tid}`. Destructive
immediate cleanup of every test-stage file row + on-disk bytes.

### POST /app/release

**Auth:** Manager on `app_tid`.

**Body:** `{app_tid, dry_run?: false}`.

**Behaviour — asynchronous.** Promoting test → release is queued as a
background job rather than run inside the request (the promotion holds a
lock and does multi-second disk I/O; doing that inline once took a
production cell down). A successful call returns
`{result:true, queued:true, job_id, status:"queued"}` — poll
`/app/release/status`. If a release job for the app is already pending or
running, you get that job's `job_id` back instead of a duplicate.

`dry_run: true` answers **synchronously** with
`{dry_run:true, data:{test_rows, release_rows_to_replace}}` and queues
nothing.

**Soft rejections (nothing queued):** an empty test stage, and a
divergence guard (`code: "draft_disk_missing"`) that refuses to promote
when the draft's bytes are not actually present — publishing would
otherwise wipe the live site.

### POST /app/release/status

**Auth:** Manager — checked against the **job's own** app, so one tenant
cannot observe another's publish progress.

**Body:** `{job_id}`. Returns `{job_id, status, progress, error,
attempts}`. Unknown ids and non-release jobs answer
`{result:false, msg}`.

### POST /app/release/list

**Auth:** Manager on `app_tid`. Body: `{app_tid}`. Lists backup
snapshots (`{ts, has_manifest}`) sorted newest first.

### POST /app/release/rollback

**Auth:** Manager on `app_tid`. **Body:** `{app_tid, backup_ts?}`.

**Two different operations behind one route**, and they answer with
different shapes. Which one you get is decided by two conditions
together, not by `backup_ts` alone:

- **Pointer swap** — taken when `backup_ts` is omitted or `0` **and** the
  app is actually serving through a release pointer. O(1), no file
  copying: current ↔ previous are swapped in a single UPDATE. Returns
  `data: {current_release_version, previous_release_version}`. Nothing to
  go back to → HTTP 200 `{result:false, code:"no_previous_release"}`.
- **Snapshot restore** — taken when `backup_ts` names a snapshot, **or**
  when the app has no release pointer at all. Restores that snapshot's
  manifest after taking a safety backup of the current release. Returns
  `data: {restored_from_ts, restored_rows, safety_backup_at}`.

So an app that has never published through the versioned pipeline gets
the restore path even from a bare `{app_tid}` call — it will look for
snapshot `0` and fail there rather than reporting
`no_previous_release`. Read `current_release_version` from
`/app/release/list`'s companions before assuming which branch you are on,
and branch your client on the keys you got back rather than on the
request you sent.

Both take the same per-app advisory lock as `/app/release`, and both
write an `app.release.rollback` audit row (the pointer swap tags itself
`mode: "pointer_swap"`).

---

## Roles

**All four role endpoints are Manager-gated, and none of them is a
Designer-level convenience.** A role tid can itself sit in
`apps.managers`, so editing a role's membership is Manager appointment by
proxy: at Designer, a user could grant themselves a Manager-conferring
role and walk up the ladder. Roles never confer Owner — that stays
`apps.author` — so Manager is the correct bar for all of them.

### POST /app/roles/list

**Auth:** Manager on `app_tid` (role membership IS access).

**Body:** `{app_tid}`. Returns `[{tid, name, description, members,
author, created_at, updated_at}, ...]`.

### POST /app/role/create

**Auth:** Manager on `app_tid`.

**Body:** `{app_tid, name, description?, members?: []}`.
`(app_tid, name)` unique — duplicate → BadRequest.

### POST /app/role/edit

**Auth:** Manager. Body: `{app_tid, tid, name?, description?,
members?}` — COALESCE-skip semantics.

### POST /app/role/del

**Auth:** Manager. Body: `{app_tid, tid}`. Atomically removes the
role + strips its `[r-xxx]` token from every `apps.<acl_array>` and
`files.<acl_array>` row in the app.

---

## Audit (per-app feed)

### POST /app/audit/list

**Auth:** Manager on `app_tid`. Lets a tenant build an in-app audit
dashboard without needing the platform-operator audit endpoints.

**Body:**
```json
{
  "app_tid":         "a-xxx",            required
  "actor":           "u-xxx",            optional, filter by acting user
  "action":          "doc.upsert.update", optional, exact action match
  "action_prefix":   "doc.",             optional, LIKE 'prefix%'
  "target_kind":     "app",              optional — see scope below for the full set
  "target_tid":      "a-xxx",            optional
  "since_ms":        1735603200000,      optional, default = now - 7 days
  "until_ms":        1735689600000,      optional, default = now
  "limit":           100,                optional, 1..=500, default 100
  "offset":          0,                  optional, cap 100000
  "include_payload": false               optional, default false — see PII note
}
```

**Window cap:** `until_ms - since_ms` must be ≤ 90 days, else
`{"code":"audit_window_too_wide"}`. `since_ms > until_ms` →
plain bad-request.

**Scope: the feed covers the app and its children.** Events on the app
row surface directly (ACL changes, app rename, owner transfer,
license-tier flips, version applies), and events on child rows are
resolved by looking the child up in its own table and matching that
table's `app_tid`. So `target_kind` is **not** always `"app"`; the
complete set it can return is:

| `target_kind` | Resolved through |
|---|---|
| `app` | the `audit_log` row's own `resource_tid` |
| `doc` · `resource` | the `resources` table |
| `file` · `folder` | the `files` table |
| `app_source` | the `app_sources` table |

Nothing else can appear — a row whose `resource_type` is outside that
set is not in the feed at all, whatever it names.

> **On a `doc` row, `target_tid` is the RESOURCE's tid, not the
> document's.** Doc writes are filed under the resource they belong to,
> and the document's own tid lives at **`detail.doc_tid`** — which means
> it is only visible when you pass `include_payload: true`.
>
> A client that joins `target_tid` against its documents will match the
> wrong key on every row, and silently: resource tids and doc tids are
> both `r-`/`d-`-prefixed opaque strings, so the join does not error, it
> just finds nothing (or, worse, groups every edit in a resource under
> one heading). To attribute an edit to a document you must request the
> payload.

**What the feed does not cover.** Two whole classes of change are
absent, and neither is a filter you can widen:

- **Membership changes are structurally invisible.**
  `/app/member/set-roles`, `/app/member/set-direct-grants` and
  `/app/member/remove` all do write audit rows — but they file them
  under `resource_type: "user"`, which is not one of the six kinds this
  feed matches. So they cannot appear here however you filter. (They are
  not lost; they are simply not reachable through the per-app feed.)
- **Role changes write no audit row at all.** `/app/role/create`,
  `/app/role/edit` and `/app/role/del` record nothing anywhere.

That matters more than it looks, because a role tid can sit in
`apps.managers`: the two operations that most change who holds power in
an app — editing a role's membership, and granting someone a direct ACL
bucket — are the two this dashboard cannot show. `app.acl_set` from
[`/app/acl-set`](#post-appacl-set) *is* captured with its full
after-state, so an ACL screen built on that endpoint is auditable while
the equivalent built on the member endpoints is not. If you are relying
on this feed for access review, bound the claim accordingly.

Two more consequences worth planning for:

- **Deleted children are not filtered out.** The lookup matches on the
  child's tid and `app_tid` only, never on `deleted_at`, so the history
  of a document survives the document. That is the point of an audit
  log, but it does mean `target_tid` may not resolve to anything you can
  fetch.
- **`app_tid` is not a column on `audit_log`, and is not going to
  become one by default.** The feed does the lookup instead. The
  alternative of trusting an app id written into the row's own `detail`
  was rejected deliberately: `detail` is not always server-authored —
  some rows carry a caller's raw body — so an attacker could inject
  themselves into another tenant's feed. Do not build on `detail` for
  tenancy.

**Refusals are events too.** A permission check that turns an identified
caller away writes a row of its own:

- `action` is exactly **`app.access.denied`** — one constant, so a
  dashboard, an operator feed and an alerting rule cannot disagree about
  the string. Reach it with `action_prefix: "app.access."` or an exact
  `action` match.
- `result` is `"failure"`, and `detail` carries
  `{required_level, doc_tid}` — `required_level` naming the level the
  caller lacked (`owner` / `manager` / `designer` / `editor` / `reader`)
  and `doc_tid` being `null` for an app-level refusal and set for a
  per-doc one. A doc refusal is still filed under the **app**, so it
  shows up in this feed.
- **Only identified callers are recorded.** Anonymous, expired and
  banned callers fail earlier, so a burst of unauthenticated probing
  leaves nothing here — this feed answers "who that I know tried to do
  what they may not", not "who knocked".
- **No sampling and no dedupe.** The same person hitting the same wall
  fifty times writes fifty rows, because the repeat pattern *is* the
  signal.
- **No `client_ip` is stored.** At that layer there is no socket peer
  and the only thing available is a caller-supplied `x-forwarded-for`
  header, which nothing has validated. A spoofable IP in an audit row is
  worse than an absent one, so the field stays empty rather than
  plausible.

**PII / payload:** `payload_json` is `null` unless caller passes
`include_payload: true`. Even then, rows that operators flagged
server-side with `detail.redact: true` come back as
`{"payload_json": {"redacted": true}}`.

**Response:**
```json
{
  "result": true,
  "data": {
    "rows": [
      {
        "tid":             "au-xxx",
        "ts":              1735689600000,
        "actor_user_tid":  "u-xxx",
        "actor_username":  "alice",
        "action":          "app.acl_set",
        "target_kind":     "app",
        "target_tid":      "a-xxx",
        "target_path":     null,
        "source_ip":       "203.0.113.1",
        "request_id":      null,
        "correlation_tid": null,
        "result":          "success",
        "payload_json":    null
      }
    ],
    "next_offset": 100
  },
  "timestamp": 1735689600000
}
```

`next_offset` is `null` when the response is the last page (fewer rows
than `limit` returned, or `offset + limit` would exceed the 100k cap).

**Three row keys are permanently null**, and no request can populate
them: `target_path`, `request_id` and `correlation_tid`. They have no
backing columns in the current schema and are emitted as literal nulls
purely to keep the response shape stable for existing clients. Do not
build a correlation or tracing feature on them, and do not read a null
there as "this event had none" — nothing has ever written them.

`source_ip` **is** real (it carries the row's recorded `client_ip`), but
see the refusal note above for one whole class of row where it is null
by design.

---

## Sharing (per-doc grants)

### POST /app/share/create

**Auth:** Editor **on the doc** — the per-doc ACL is evaluated, so an
app-level Editor who is vetoed by the doc's `noaccess[]` is denied. Email
verification is *not* required here. The doc's resource must also have
`sharing = TRUE` (a resource row that no longer exists defaults to
enabled).

**Body:**
```json
{
  "app_tid":    "a-xxx",     required
  "doc_tid":    "d-xxx",     required
  "target":     "u-xxx"      // OR "G_<grp>" | "[r-<role>]" |
                             //    "G_author" | "anonymous"
  "fields":     ["..."],     optional; JSON array of dot-paths;
                             // [] = metadata only; null = full
  "expires_at": 1700000000000, optional
  "resharable": false,        optional, default false
  "note":       "string"      optional
}
```

**Response:** `{tid, target, token}`. `token` is non-empty
(32-char hex) **only when `target == "anonymous"`** — the share link.

### POST /app/share/list

**Auth:** Editor on `app_tid`. Body: `{app_tid, doc_tid?}`. Returns up
to 200 shares sorted by `granted_at DESC`.

### POST /app/share/revoke

**Auth:** Editor. Body: `{app_tid, tid}`. Sets `revoked_at = now`.
Not-found / already-revoked → `share_not_found`.

### POST /app/share/claim

**Auth:** Anonymous. Body: `{app_tid, token}`. Resolves an anonymous
share token to the projected doc payload (`fields` applied). Validates
revocation / expiry / doc deletion. No cookie issued.

---

## Domains

**Gates at a glance.** Binding a domain to your own app moved to
**Manager** on 2026-08-17; only removal stayed Owner. Everything that
acts on a *parent* domain — approving delegations, whitelists, modes —
is Owner **and** additionally requires that the parent row belongs to
the app you named.

| Endpoint | Level |
|---|---|
| `/app/domain/preview` · `/add` · `/verify` · `/request` | **Manager** |
| `/app/domain/list` | **Designer** |
| `/app/domain/del` | **Owner** |
| `/app/domain/mode` · `/label-rules` · `/get-config` · `/whitelist/*` · `/subs-of-parent` · `/delegation/test-pattern` · `/requests/received` · `/request/approve` · `/request/deny` | **Owner** of the parent, and the parent must belong to the named app |
| `/app/domain/reclaim-sub` | **Owner** on the admin app you name |
| `/app/domain/delegations/received` · `/requests/mine` · `/request/cancel` | no app-level permission — signed-in caller only |

### POST /app/domain/preview

**Auth:** Manager on `app_tid`. Body: `{app_tid, domain}`.

**Response** — one of several branches:
- `already_owned: true` — this app already holds the domain.
- `auto_active: true` with `shortcut: {parent_app_tid, parent_domain}` —
  you own a parent domain, so no DNS step is needed.
- `delegation: {...}` — a parent owner has granted you sub-binding.
- otherwise DNS instructions, with the verification material nested at
  `data.verify`.

On a local-dev host the reply is `auto_active: true`.

### POST /app/domain/add

**Auth:** Manager on `app_tid`.

**Body:** `{app_tid, domain}`. There is **no** `verify_token` field —
the A-record-only contract replaced the older TXT/token handshake. A
`verify_token` sent by an older client is silently ignored. (Some
`/preview` responses still carry a legacy note telling you to send one;
disregard it.)

**Behaviour:** verifies DNS, INSERTs `domains` row with `active = TRUE`.
Idempotent on same-app re-add.

**Two different quota refusals live here, with two different statuses.**
Read them apart before you automate anything:

| Code | Status | Source |
|---|---|---|
| `domain_quota_reached` | **402** | the app's own cap, `licenses.domain_max_per_app`, on `/preview` and `/add` |
| `quota_reached` | **200** `{result:false}` | the delegation gate — a parent owner's `max_subs` grant is spent — on `/preview` and `/add` |

`domain_quota_reached` is deliberately a hard status, and one of the few
places the platform breaks its own 200-`{result:false}` habit. Answering
200 here let an automated publish read "fine" and go on to make a DNS
change that could never work; a 402 stops the pipeline at the step that
actually failed.

The delegation refusal is the softer one because it is remediable by
asking a person — see
[bind requests](#bind-requests-asking-a-parent-owner-for-permission).
Note that on `/app/domain/request` the same delegation condition
degrades further, to a **400 `bad_request`** with the `quota_reached`
code dropped entirely, so do not match on that code there.

### POST /app/domain/list

**Auth:** Designer on `app_tid` (loosened from Owner so the Domains
tab renders). Returns rows + computed `badge` (`live | warming |
needs_recheck`) + DNS instructions for inactive rows.

### POST /app/domain/del

**Auth:** Owner on `app_tid`. Body: `{app_tid, tid}`. Hard removes the
domain row. Audit-logged.

### POST /app/domain/verify

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`. Recovery /
re-check for an existing row that's been flipped inactive (e.g. by
the DNS recheck worker).

---

## Domain delegation

Lets a parent-domain owner allow other users to bind sub-domains under
their parent without doing DNS verification themselves.

### POST /app/domain/mode

**Auth:** Owner of the parent domain (`require_parent_owner`).

**Body:** `{app_tid, domain, mode: "private" | "public"}`. First-time
public auto-populates fail-safe default label rules.

### POST /app/domain/label-rules

**Auth:** Parent owner. Body: `{app_tid, domain, allow: [...],
deny: [...]}`. Patterns are regex; max 10 each, 200 chars per pattern.

### POST /app/domain/get-config

**Auth:** Parent owner. Body: `{app_tid, domain}`. Returns
`{domain, mode, label_rules:{allow,deny}, whitelist_count,
public_default_rules}`.

### POST /app/domain/whitelist/add

**Auth:** Parent owner.

**Body:**
```json
{ "app_tid", "domain", "grantee_user_tid",
  "expires_at": 1700000000000?,
  "max_subs":   3? }
```
Upsert. `max_subs >= 1` if set; absent = unlimited.

### POST /app/domain/whitelist/remove

**Auth:** Parent owner. Body: `{app_tid, domain, grantee_user_tid}`.
Pre-existing sub-domain bindings are NOT removed.

### POST /app/domain/whitelist/list

**Auth:** Parent owner. Body: `{app_tid, domain}`. Returns **all**
whitelist rows for the parent — expired grants included, newest first:
`{tid, grantee_user_tid, granted_by, conditions, max_subs, expires_at,
created_at}`. Filter on `expires_at` client-side if you only want live
grants.

### POST /app/domain/delegations/received

**Auth:** Authenticated (any user) + email verified.

**Body:** `{}`. Returns parents the caller can bind under, either via
whitelist or via `mode=public`.

### POST /app/domain/reclaim-sub

**Auth:** Caller is the owner of the LONGEST strict-suffix parent of
`sub_domain`.

**Body:** `{admin_app_tid, sub_domain, reason?}`. Unbinds the sub from
whichever app currently holds it (the sub's app row is NOT deleted).

### POST /app/domain/subs-of-parent

**Auth:** Parent owner. Body: `{app_tid, domain}`. Returns every sub
bound under the parent — **active and inactive** — joined with app
metadata: `{tid, domain, app_tid, app_name, app_owner, active,
created_at}`, newest first.

### POST /app/domain/delegation/test-pattern

**Auth:** Parent owner. Dry-run helper for the label-rules editor.

**Body:** `{app_tid, domain, label, allow: [...], deny: [...]}`.

**Response data:** `{verdict: "allow"|"deny"|"no-allow-match",
matched_pattern, reason}`.

### Bind requests (asking a parent owner for permission)

When a would-be sub-binder hits a `private` parent with no whitelist
entry, the refusal carries `code: "private_needs_request"`. That is the
entry point to this workflow — the only refusal it can remedy (a
label-rule denial or an exhausted quota cannot be requested away).

| Endpoint | Auth | Body | Notes |
|---|---|---|---|
| `POST /app/domain/request` | **Manager** on the requesting app + verified email | `{app_tid, domain, note?}` | Idempotent — resubmitting reuses the pending row and reports `already_pending`. Returns `{tid, parent_domain, requested_host, status, already_pending}` |
| `POST /app/domain/requests/mine` | Authenticated | none | your own requests, ≤ 200, newest first |
| `POST /app/domain/request/cancel` | Authenticated — **the original requester only** | `{request_tid}` | pending requests only |
| `POST /app/domain/requests/received` | Parent owner | `{app_tid, domain}` | pending requests against that parent, oldest first |
| `POST /app/domain/request/approve` | Parent owner | `{app_tid, domain, request_tid, max_subs?, expires_at?}` | mints the whitelist grant; re-approving updates it. `max_subs` ≥ 1 if given, absent = unlimited. Returns `{request_tid, delegation_tid, grantee_user_tid}` |
| `POST /app/domain/request/deny` | Parent owner | `{app_tid, domain, request_tid}` | |

Approve/deny/received are pinned to the parent you name, so an owner
cannot act on a request filed against somebody else's parent
(`not_found`). Requesting a domain you can already bind, or one that is
not under a private parent, is a bad request.

---

## Operators (integrations catalog + invocation)

### POST /app/integrations/list

**Auth:** Reader on `app_tid`. Body: `{app_tid}`. Returns the operator
catalog (`id, display_name, description, min_license, actions[],
config_schema, enabled, configured, updated_at`).

### POST /app/integrations/enable

**Auth:** Manager on `app_tid` + tenant license tier satisfies
`operator.min_license` (else `license_tier_required`).

**Body:** `{app_tid, op_id}`. Upserts `operator_configs` row with
`enabled = TRUE`.

### POST /app/integrations/disable

**Auth:** Manager on `app_tid`. Body: `{app_tid, op_id}`. Flips
`enabled = FALSE` (config retained).

### POST /app/integrations/config-get

**Auth:** Manager on `app_tid`. Body: `{app_tid, op_id}`. Returns the
decrypted config JSON. Two non-config replies, distinguishable by
`result`: not yet configured →
`{"result":true,"data":null,"msg":"not configured yet"}`; operator not
enabled → `{"result":false,"msg":"operator not enabled for this app"}`.
Neither carries a `code`.

### POST /app/integrations/config-set

**Auth:** Manager on `app_tid`. Body: `{app_tid, op_id, config}`.
Validates against the operator's schema. Encrypted at rest in
`operator_configs.config_encrypted`.

### POST /op/:op_id/:action

**Generic operator dispatcher.**

**Auth:** Default-deny. Unless the operator explicitly lists `action`
as public, the caller must hold **Reader** on `app_tid`. Only explicitly
public actions (OAuth callbacks, customer-facing utilities) run
unauthenticated. A best-effort session lookup then populates the
operator context — it may legitimately be anonymous for a pre-login
operator such as the VNeID `auth` action.

**Body:** must include `app_tid`. Any extra fields are forwarded as the
operator payload (`#[serde(flatten)]` on `extra`).

**Response (success):** `{result: true, data: <operator output>,
timestamp}`. Errors mapped per `OpError`:
- `NotEnabled` → `{"msg":"operator not enabled for this app"}`
- `NotConfigured(m)` → `{"msg":"operator not configured: <m>"}`
- `Invalid(m)` → **400** `{"result":false,"msg":m,"code":"bad_request"}`
- `Upstream{service,message}` → `{"msg":"<service> upstream error: <m>"}`
- `Internal(m)` → 500.

Every **invoked** call writes an `op_invocations` audit row, success or
failure. Calls rejected before dispatch — unknown `op_id`, unknown
action, the Reader gate, a license-tier refusal — are not recorded there.

---

## WASM operators — tenant server-side code

The catalog above is platform-shipped (VietQR, VNeID, …). **WASM
operators** are the open lane for *your own* server-side logic: upload a
compiled `.wasm` module per app and it runs in a sandbox. The platform
owns the engine, ABI, and limits; the app owns the module. A module is
scoped to its `app_tid` and can never see another app's data.

### When to use it

| Need | Use |
|---|---|
| "field X is required / numeric / one of these / a link" | [field validator](#field-validators) |
| "field X must be present" | `require_fields` hook |
| "copy/derive a field on write" | `set_fields` hook |
| "reject based on several fields at once" | [JS code hook](#js-code-hooks) |
| "call an external HTTP service" | `webhook` hook, or a catalog operator |
| **custom server-side computation over your own data** | **WASM operator** |
| **stateful, crash-recoverable server-side workflow** | [durable operator](#durable-operators-off-by-default) |

There are now **two** sandboxed code lanes, and they solve different
problems. A [JS code hook](#js-code-hooks) is the cheap one: it lives on
the resource, runs in-process with a 100 ms budget, and is ideal for
cross-field validation or deriving a value on write. A WASM operator is
the heavy one: a compiled module you upload and version, with a much
larger compute budget and — uniquely — a bridge that can read and write
your app's data. Neither can reach the network.

### Two ways to invoke

1. **Doc-lifecycle hook** — add to `resources.hooks`:
   `{ "id":"validate", "on":["before_create","before_update"], "type":"wasm", "params":{"op_id":"my-validator"} }`.
   `before_*` may mutate or reject the doc before commit (a reject blocks
   the write, code `wasm_rejected`); `after_*` is side-effect only
   (rejection logged, never propagated).
2. **HTTP endpoint** — `POST /op/<op_id>/<action>` with body `{app_tid, …}`.
   If `<op_id>` is not a catalog operator, dispatch falls through to your
   active WASM module. Non-public ops require **Reader**; `public` ops run
   unauthenticated (webhooks/callbacks) with **no** data bridge.

### Sandbox & limits (per invocation; defaults, per-tier tunable)

| Limit | Default | Tier override |
|---|---|---|
| CPU (wasmi fuel) | 50,000,000 | `licenses.wasm_max_fuel` |
| Linear memory | 64 MiB (a *ceiling*, grown on demand — light ops cost little) | `licenses.wasm_max_memory` |
| Wall-clock | 5 s | — |
| Host data calls | 1,000 | — |

No filesystem / network / clock / randomness / syscalls. Time arrives as
`now_ms` in the request; data only via host calls. Exceeding a limit →
`wasm_limit_exceeded`. Engine = `wasmi` interpreter (deterministic).

### Data access & ACL (the key guarantee)

A module reaches its app's data via host calls (`host_query` /
`host_mutate`) that run **as the invoking end-user**:
- App-scoped — a module only touches its own `app_tid`'s data.
- App-level `Reader` is required before the host bridge is handed to the
  module at all, and `public` operators get **no** host bridge (pure
  compute / webhook only).
- `host_query` returns only the **searchable (level-0) `data_indexed`**
  half of a row. It never decrypts `data_secret`, so field-level
  encrypted values are not reachable through a module.
- `host_mutate` create needs app-Editor + write-scope; update needs
  per-doc Editor + bidirectional scope (current **and** post-merge row).

> **`host_query` applies the same three gates as `/app/doc/list`.** A
> module is not a way around the read path.
>
> 1. **App permission** for the invoking user, re-resolved *inside* the
>    host rather than trusted from the module. A refusal is an error
>    envelope (`code: "host_query_failed"`) and writes an access-denied
>    audit row.
> 2. **The resource's own ACL** (`readers`/`editors`/`noaccess`). A
>    denied caller gets an **empty array, not an error** — the same
>    no-existence-leak answer the HTTP path gives, so a module cannot
>    probe for a resource it may not see.
> 3. **Row-level scope and PII level.** Rows outside the caller's cohort
>    are dropped, `Aggregate`-only rows are dropped entirely, and
>    `Masked` rows are masked before the guest ever sees them.
>
> Gate 3 is **environment-conditional in exactly the way
> `/app/doc/list`'s is** — it does nothing unless `TFL5_ENFORCE_SCOPE`
> is on *and* the app populated `apps.acls.scope.field_map`. Parity with
> the HTTP path holds either way, but the fence is only as strong as
> that configuration. An opted-in app querying a resource missing from
> `field_map` fails **closed** with `scope_not_configured`.
>
> ⚠ Two things to design around:
> - **An empty result is also what a denial looks like.** Never read
>   empty as proof that no rows exist. (An *unknown* `resource_ma` does
>   return an error, so a guest can tell "no such resource name" from
>   "denied" — but never "denied" from "zero matching rows".)
> - **`host_query` returns no `meta`.** Where `/app/doc/list` reports
>   `meta.scope_filter_applied` and `meta.pii_aggregate_dropped`, the
>   bridge returns only `{"ok":true,"data":[…]}`. A module cannot detect
>   that filtering happened.
> - A binding rated `Masked` against a resource that declares no
>   `pii_fields` returns the row **unmodified** — masking needs a field
>   list to act on.
>
> Per-doc `readers`/`noaccess` are not part of either path: in this
> platform per-doc ACL gates writes (`update`, `del`, `acl-set`), not
> reads, so `/app/doc/list` does not enforce them either.

### ABI (compiling a module)

The guest exports `memory`, `tfl5_alloc(i32) -> i32` and
`tfl5_invoke(i32, i32) -> i64`; the host provides `host_log` and
`host_call` under the module name `"tfl5"`. Request and response are
JSON passed over linear memory, and the ABI carries a version number.
Any language that targets WASM (Rust, TinyGo, AssemblyScript) works.
Additional per-invocation caps beyond the table above: 256 KiB per host
request payload, 4 KiB per log line, and a limit on table elements.

**The byte-level contract lives in
[wasm-operator-abi.md](./wasm-operator-abi.md)** — memory layout, the
full host-call surface, and an error-vs-silence table for the three
gates above. This section is the REST-facing summary; that document is
the reference to build a module against.

### Lifecycle endpoints (Manager on `app_tid`)

> These three endpoints answer with **flat** envelopes rather than the
> usual `data` wrapper — see each response shape below.

### POST /app/wasm/list

**Auth:** Manager. Body: `{app_tid}`. Returns
`{result:true, operators:[…]}` (no `data`, no `timestamp`); each row
carries `op_id, version, active, public, min_license, sha256,
total_bytes, uploaded_by, uploaded_at`.

### POST /app/wasm/upload  *(multipart)*

**Auth:** Manager. Fields: `app_tid, op_id, version, file` (the `.wasm`,
≤ 10 MB) plus optional `public`, `min_license` (defaults to the lowest
tier), `notes`. The module must load and export the ABI surface
**before** it is stored, and it is stored **inactive**.

**Response:** `{result, tid, op_id, version, sha256, total_bytes, active,
public, timestamp}`.

**Codes:** `wasm_module_invalid`, `wasm_version_exists`,
`wasm_op_id_invalid`, `wasm_version_invalid`, `file_too_large`.

### POST /app/wasm/activate

**Auth:** Manager. Body: `{app_tid, op_id, version}`. Atomically flips the
single active version per `(app_tid, op_id)`, advisory-locked. Re-checks
the license tier (`license_tier_required`) — and re-checks it again on
**every dispatch**, so a later downgrade stops an already-activated
module. Unknown version → `wasm_version_not_found`.

**Response:** `{result, op_id, active_version, timestamp}`.

Every invocation (hook or HTTP) writes an `op_invocations` row
(`latency_ms, success, error_kind, fuel_consumed`) for audit/billing.

---

## Signed sources — external system → app, through the ACL gate

tfl5 is domain-blind: it does not know what the incoming data is or
where it comes from. A **signed source** makes any external push obey
the app's ACL/schema generically — without a privileged write path.
Use it for a hospital HIS, a payment webhook, an IoT bridge, or any
system that pushes structured rows into an app resource.

**Key guarantee (same invariant as WASM operators):** the write lands
through the normal ACL-gated doc-write pipeline. tfl5 never bypasses
the gate; it only resolves a principal. A principal that lacks Editor
access to the target resource is rejected even if the signature is
valid.

### POST /app/source/register

**Auth:** Manager on `app_tid`.

**Body:**
```json
{
  "app_tid":             "a-xxx",          // required
  "name":                "his-east-wing",  // required, unique per app, ≤ 120 chars
  "target_resource_ma":  "lab_result",     // required; fixed target resource
  "idempotency_pointer": "/external_ref",  // optional; JSON-pointer into payload → dedup key
  "replay_window_secs":  300               // optional; default 300
}
```

**Response (success):**
```json
{
  "result": true,
  "data": {
    "tid":                "src-<uuid>",
    "name":               "his-east-wing",
    "secret":             "<64-char hex>",       // shown ONCE — store it now
    "ingest_url":         "/ingest/src-<uuid>",
    "principal_user_tid": "u-svc-<uuid>",        // AUTO-CREATED service principal
    "target_resource_ma": "lab_result",
    "replay_window_secs": 300
  },
  "timestamp": 1700000000000
}
```

**Notes:**

You do NOT provision a user. Registering a source auto-creates a
login-less service principal (`u-svc-…`) and appends it to the **app's**
`editors[]` — i.e. app-level Editor, not a grant scoped to one resource.
What confines the source to `target_resource_ma` is the source row
itself: that is the only resource it can write. Every push acts AS that
principal through the normal ACL gate. Revoking the source removes the
principal from `editors[]`. The caller never supplies an identity —
`principal_user_tid` is returned by the server, not sent by the client.

- The secret is **master-key-encrypted** at rest (AAD bound to
  `app_tid|source_tid`) — a stolen DB dump cannot forge a push.
- `(app_tid, name)` unique — duplicate → `BadRequest`.

### POST /app/source/list

**Auth:** Manager on `app_tid`. Body: `{app_tid}`. Returns up to 500
active (non-revoked) sources with metadata. **The secret is never
returned by list** — it only leaves the server on register/rotate.

### POST /app/source/rotate

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`. Generates a
fresh secret (old secret immediately invalidated). Returns
`{tid, secret}` (shown once).

### POST /app/source/revoke

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`. Soft-deletes
the source, removes the auto-provisioned service principal from the
app's `editors[]`, and invalidates the secret. Subsequent pushes with
that `source_tid` get HTTP 200 + `{"result":false,"code":"not_found"}`.

### POST /ingest/:source_tid

**Auth:** HMAC-SHA256 signature (no cookie / bearer required).

**Headers:**
- `X-Tfl5-Timestamp` — current Unix time in **seconds** (integer).
- `X-Tfl5-Signature` — hex HMAC-SHA256 of `"<timestamp>.<raw body>"`
  (full body, so any tampering invalidates).

**Body:** a JSON object — the data row to write. Extra keys not in the
resource schema are stored verbatim; declared fields are
validated/encrypted per the resource definition.

**Signature construction (caller side):**
```
message  = timestamp_string + "." + raw_body_bytes
sig      = hmac_sha256(secret_hex, message)
header   = hex(sig)
```

**Replay protection:** the server rejects requests where
`|now - X-Tfl5-Timestamp| > replay_window_secs` (default 300 s).
Configure a tighter window via `replay_window_secs` on register.

**ACL gate:** after signature verification, the handler calls
`app_perm_for_user(principal, Editor)`. If the principal lacks Editor
on the app, the push is denied (`access_denied`) even with a valid
signature.

**Idempotency:** if `idempotency_pointer` was set (e.g. `/external_ref`),
the server extracts that JSON-pointer value from the payload and uses
it as a dedup key. A duplicate key within the window → no second row,
response is still success.

**Response (success):**
```json
{
  "result": true,
  "data": {
    "tid":          "d-xxx",
    "resource_tid": "r-xxx",
    "ingested":     1,
    "deduped":      0
  },
  "timestamp": 1700000000000
}
```

`ingested: 0, deduped: 1` when the push was a recognised duplicate.

**Error cases:**
- `X-Tfl5-Timestamp` missing or non-numeric → **400** `bad_request`.
- Timestamp outside replay window → **400** `bad_request`.
- `X-Tfl5-Signature` missing or not hex → **400** `bad_request`.
- Body not JSON, or not a JSON object → **400** `bad_request`.
- Signature mismatch → 200 `access_denied`.
- Principal lacks Editor → 200 `access_denied`.
- Source not found / revoked → 200 `not_found`.

---

## Email (per-app inbox + send)

### POST /app/email/send

**Auth:** Manager on `app_tid`. Mailler must be configured.

**Body:**
```json
{
  "app_tid":    "a-xxx",        required
  "from_local": "noreply",      required, no '@'
  "from_domain":"acme.com",     optional; validated — see below
  "to":         ["..."],        required, ≥ 1
  "subject":    "string",       required
  "html":       "string",       optional; html or text required
  "text":       "string",
  "reply_to":   "string"        optional
}
```

**The sender is verified against a DKIM key before anything is
queued.** Both shapes are checked, and both fail with the same code:

- **`from_domain` given** — it is lower-cased and looked up among *this
  app's* DKIM keys. No key for that specific domain → **400**
  `email_dkim_not_configured`. Naming a domain the app has not
  configured is not a way to borrow another app's signature.
- **`from_domain` omitted** (or blank) — falls back to the app's oldest
  DKIM key, as before. If the app has **no** key at all, that is the
  same **400** `email_dkim_not_configured`, distinguished only by `msg`.

Previously the explicit path was not checked at all, and the endpoint
answered `{result:true, queued:true}` for mail the platform could never
sign — a success envelope for a message that was going to be dropped
downstream. Match on the code and treat it as "fix your DKIM setup",
not as a transient failure.

**Recipients are shape-checked too.** Every entry of `to[]` must be a
plausible address — one `@`, non-empty local part, no whitespace, ≤ 254
characters, and a domain of at least two non-empty dot-separated
labels. The first bad one is refused **400** `email_invalid_recipient`,
and the offending value is echoed back in `msg` so a UI can point at the
right row. An empty `to[]` is a plain bad request with no code.

Checks run in this order, so the first failure you see is the outermost
one: mailer configured → DKIM/`from_domain` → `from_local` → recipients
→ `html`/`text` present.

**Response:** async by default — `{queued:true, tid, from, to}`.
Sync path (`TFL5_QUEUE_SYNC=1`) waits for delivery and returns
`{tid, from, to, provider, provider_msg_id}`.

### POST /app/email/sends

**Auth:** Reader on `app_tid`. Body: `{app_tid, limit?}` (clamp
1..=500, default 100). Outbound audit list.

### POST /app/email/inbox

**Auth:** Reader on `app_tid`. Body: `{app_tid, limit?}`. Per-app
catch-all inbox (writer is `tfl5-mail`).

### POST /app/email/mark-read

**Auth:** Editor on `app_tid`. Body: `{app_tid, email_tid?}`. Omit
`email_tid` to mark all unread as read.

### POST /app/email/dkim/create

**Auth:** Manager on `app_tid`. Body: `{app_tid, domain}`. Mints a
DKIM keypair via mailler and persists. Upsert on
`(app_tid, domain, selector)`.

### POST /app/email/dkim/list

**Auth:** Reader on `app_tid`. Body: `{app_tid}`. Returns
`[{domain, selector, public_dns, created_at}, ...]`.

### POST /app/email/dns-records

**Auth:** Reader on `app_tid`. Body: `{app_tid, domain}`. Returns
SPF/DKIM/DMARC/MX assembly for the given (app, domain).

---

## F3 — secure attached files (per-doc)

Files attached to a doc, encrypted server-side; the key derives from
the app key via the doc's DEK. Gates differ per endpoint: `upload`,
`edit`, `download`, `list` and `delete` are checked against the **doc's**
ACL; `grant` / `revoke` need app-Editor; `access-log` and `grants/list`
need app-Manager.

### POST /app/f3/upload

**Auth:** Editor on the doc (via `require_doc_perm`).

**Multipart fields:** `app_tid` (text), `doc_tid` (text), `level`
(text, `"1"|"2"|"3"`, default `1`), `name` (text), `file` (binary).

**Limits:** 100 MB per file (the whole request is capped at 110 MB, so
one maximal file plus its multipart envelope fits and two do not).
Levels: 1 = internal, 2 = confidential (per-access audit), 3 =
top-secret (per-grantee envelope).

**F3 uploads consume storage quota, so size is not the only way this
call fails.** The bytes are charged against both the app's storage cap
and the owner's total-storage cap, and the check runs **before** the
object is written, so a refusal leaves nothing behind. Overshoot →
**400** `quota_app_max_storage` — the same code the ordinary file
routes use, with only `msg` distinguishing the app cap from the owner
cap.

Two details that change the arithmetic:

- **You are charged in ciphertext bytes, not plaintext.** Encryption
  happens first and the encrypted length is what is billed, so budget
  slightly above the file size you uploaded.
- **A re-upload of content the doc already holds skips the check.**
  Likely duplicates are not charged, so an idempotent retry of a large
  attachment will not fail on quota even when a first upload would.

Before this was wired in, F3 bytes never touched the app's
`used_storage` at all and an F3 upload could not fail on quota — if you
are reading an older integration that only handles `file_too_large`,
that is why.

### POST /app/f3/edit

**Auth:** Editor on the app (checked while the upload streams) **and**
Editor on the owning doc (re-checked once `doc_tid` is resolved).

**Multipart fields:** `app_tid` (text), `f3_tid` (text, required),
`name` (text, optional — keeps the existing name when omitted), `file`
(binary). `doc_tid` and `level` are **not** accepted: a file's doc and
confidentiality level are immutable. A level-3 file keeps its original
DEK, so existing grants stay valid. Fails with a bad-request if the
platform's F3 storage backend changed since the original upload.

### POST /app/f3/download

**Auth:** Reader on the doc (level 3 also requires an unrevoked
grant for the caller).

**Body:** `{f3_tid}`. Returns the plaintext bytes as
`application/octet-stream` (or stored MIME) with
`Content-Disposition: attachment; filename="<name>"`. Level ≥ 2
writes an `f3_access_log` row per call.

### POST /app/f3/list

**Auth:** Reader on the doc. Body: `{app_tid, doc_tid}`. Metadata only.

### POST /app/f3/delete

**Auth:** Editor on the doc + `doc_acl.is_deletable_by(caller)`.
Body: `{f3_tid}`. Soft delete.

### POST /app/f3/access-log

**Auth:** Manager on the app. Body: `{f3_tid}`. Returns up to 500
audit rows.

### POST /app/f3/grant

**Auth:** Editor on the app + caller must already hold an unrevoked
grant on the file. Only valid for level-3 files. Body:
`{f3_tid, grantee_user_tid}`. Seals the file DEK for the grantee.

### POST /app/f3/revoke

**Auth:** Editor on the app. Body: `{f3_tid, grantee_user_tid}`.
Soft-revoke. Level-3 files only; when no active grant matched, the reply
is `{"result":false,"msg":"no active grant for that grantee"}`.

### POST /app/f3/grants/list

**Auth:** **Manager** on the app — the key-holder roster is a
control-plane view, like `/access-log`. Body: `{f3_tid}`. Lists all grant
rows (`grantee_user_tid, granted_by, granted_at, revoked_at,
revoked_by`), newest first.

---

## Public forms (anonymous submissions)

Lets an app accept submissions from people who are not signed in — a
contact form, a registration, a survey. A form does not exist until a
Designer configures it; until then, submitting returns
`public_form_not_configured`.

### POST /app/public-form/submit

**Auth:** **Anonymous** — no cookie required.

**Body:** `{app_tid, form_id, fields: { ... }}`.

**Validation**, in order:
1. Hard cap of 32 fields per submission → `public_form_too_many_fields`.
2. Unknown fields are rejected (`public_form_unknown_field`) unless the
   schema sets `allow_unknown_fields: true`.
3. Per declared field: `required` → `public_form_field_required`;
   `max_len` (default 4096 chars) → `public_form_field_too_long`;
   `type: "email"` → `public_form_field_invalid_email`.

**Anti-abuse:** a per-IP sliding-hour cap (`rate_per_ip_per_hour`,
default 5) → `public_form_rate_limited`, and a lifetime cap per
`(app, form)` (`max_total_submissions`, default 10 000) →
`public_form_quota_full`. The platform's general per-IP rate limit
applies on top. There is **no** CAPTCHA / Turnstile check on this
endpoint — if you need one, put it in front of your own page.

**Stored:** the sanitised field map plus the client IP, user agent
(first 512 chars) and timestamp.

**Response:** `{result: true, submission_tid, timestamp}`.

### POST /admin/public-form/set-config

Despite the `/admin/` prefix this is an **app-scoped** endpoint, not a
platform-operator one.

**Auth:** **Designer** on `app_tid`.

**Body:** `{app_tid, form_id, schema}`. A `null` schema deletes the form.

**Schema keys:** `fields`, `allow_unknown_fields`,
`rate_per_ip_per_hour` (1..=10000), `max_total_submissions`
(1..=10000000), `scope_attrs`. Field names must match `[a-z0-9_]{1,32}`,
at most 32 of them; each field may set `type` (`string`, `email`,
`number` or `bool`) and `max_len` (1..=65535). Anything else →
`public_form_schema_invalid` (or `public_form_scope_attrs_invalid`).

### POST /admin/public-form/get-config

App-scoped like its siblings, despite the `/admin/` prefix.

**Auth:** **Designer** on `app_tid` — matching the *write* gate above,
not `/list`'s Manager. Reading a form's shape is part of editing it.

**Body:** `{app_tid, form_id?}` (a blank `form_id` counts as absent).

**Response `data`, two shapes:**

- **with `form_id`** — `{form_id, configured, schema}`. `configured` is
  a boolean and `schema` is the object or `null`.
- **without `form_id`** — `{forms, form_ids}`, where `forms` is the
  whole `public_forms` map and `form_ids` is an array of its keys. Note
  the map is **nested under `forms`**, not returned bare.

**A missing app and an unconfigured form are different answers.** A
`app_tid` that does not exist (or that you cannot see) is `not_found` —
which, as everywhere on this platform, arrives as HTTP 200
`{result:false, code:"not_found"}`. A form that simply has no config is
**not** an error: it is `configured: false` with `schema: null`. An app
with no forms at all returns `forms: {}`, never null.

Under [row-level scope](#row-level-scope-req-tfl5-006), a caller whose
binding is not global must name `form_id` → 400 `scope_form_required`.

**Read before you write.** `set-config` replaces a form's schema
wholesale and a `null` schema deletes the form, so a UI that edits
without reading first is writing over state it cannot see.

### POST /admin/public-form/list

**Auth:** **Manager** on `app_tid` (again app-scoped, not platform).

**Body:** `{app_tid, form_id?, limit?, before_ts?}` — `limit` clamps to
1..=200 (default 50); page backwards with `next_before_ts`.

**Response:** `{submissions:[{tid, form_id, client_ip, user_agent,
fields, created_at}], next_before_ts}`.

When [row-level scope](#row-level-scope-req-tfl5-006) is active, a
scoped Manager may only list a form their binding admits, and must name
`form_id` unless their binding is global (`scope_form_required`).
PII-masked bindings get redacted `fields`.

---

## Public read by code

### GET /public/:app_tid/:resource_ma/:public_code

**Auth:** **Anonymous** — no cookie, no scope filter.

A generic "share by unguessable code" read. The resource must have
`sharing = TRUE` (the same kill-switch `/app/share/*` uses); otherwise
every request answers `not_found`. Lookup is an exact match on the doc's
`public_code` field — there is no listing or enumeration.

**Returns** `{resource_ma, public_code, data, created_at, updated_at}`.
Only plaintext (level-0) fields are ever read — encrypted fields are
never touched. A resource may narrow the projection further with a
`public_fields` whitelist in its ACL blob. Soft-deleted rows, missing
resources and unknown codes are all indistinguishable `not_found`.

---

## Realtime chat

Per-app chat rooms over a websocket, with a REST history endpoint.
Rooms are configured per app; an unconfigured room defaults to
**Reader** minimum.

### GET /ws/chat?app_tid=…&room=…

**Auth:** the **session cookie**, checked *before* the upgrade — a
failure is a plain 401/403, never a 101. The required level is the
room's `min_level` (default Reader), and the caller's row-level scope
must admit the room. `room` defaults to `general`. A draining node
answers 503 + `service_draining` with `Retry-After`.

**Query:** `?app_tid=…&room=…`, plus the optional `&since_ts=<ms>`
resume cursor described below.

**Frames are JSON text** (binary frames are refused with
`binary_unsupported`). There are **five** server frames, not four:

| Client sends | Server sends |
|---|---|
| `{"type":"ping"}` | `{"type":"pong","ts"}` |
| `{"type":"msg","text":"…"}` | `{"type":"msg","tid","from","from_user_tid","room","text","ts"}` broadcast to the room |
| — | `{"type":"welcome","username","app_tid","room","resume_from","ts"}` on connect |
| — | `{"type":"deleted","tid","room","ts"}` when a moderator retracts a message |
| — | `{"type":"error","code","msg","ts"}` |

> **A client that ignores `deleted` leaves retracted messages on screen
> forever.** It is sent on every moderator delete
> (`/admin/chat/delete-message`), carries the `tid` of the message to
> remove and the tombstone timestamp in `ts`, and it is the only signal
> a live socket gets — `/app/chat/history` simply omits deleted rows, so
> a session that never refetches never learns.
>
> Cross-cell fan-out for retractions rides a **separate** channel from
> the one messages use. That is deliberate: during a rolling upgrade, a
> peer still running the previous build parses everything on the message
> channel as an insert, and would re-broadcast the row that was just
> deleted as a live message. It does not listen on the delete channel at
> all, so the worst case mid-rollout is the old behaviour — no
> cross-cell retraction — never a resurrection.

Error codes on the socket: `invalid_json`, `unknown_type`, `empty_msg`,
`persist_failed`, `lagged` (recoverable — see below),
`binary_unsupported`.

A message is persisted **before** it is broadcast, and you see your own
message via the broadcast rather than a local echo. Delivery is
cross-cell.

#### Resuming after a drop (`since_ts`)

Connect with `?since_ts=<epoch_ms>` and the server replays the room's
messages **strictly newer** than that cursor before the live stream
starts: oldest-first, tombstoned rows excluded, each frame an ordinary
`msg` carrying an extra **`"resumed": true`** so a client can render
backfill differently from live traffic. The `welcome` frame echoes the
cursor back as `resume_from` (null on a first connect).

The replay is capped at **200 messages**. Past that — or if the replay
query fails — the server sends **`{"type":"error","code":"lagged"}`
instead of the replay, not after it**: you get zero backfill frames and
must reload through `/app/chat/history`. Treat `lagged` as "my cursor is
too old, refetch", never as "I have some of it".

`lagged` also arrives on a live socket that falls too far behind the
broadcast buffer. Same remedy either way.

### POST /app/chat/history

**Auth:** same gate as the socket — the room's `min_level` plus scope.

**Body:** `{app_tid, room?, limit?, before_ts?, after_ts?}` (`limit`
1..=200, default 50). Returns `{messages:[{tid, from_user_tid, from,
text, ts}], next_before_ts, next_after_ts}`. Deleted messages are never
included.

**Paging goes both ways, and the sort order never changes.** `before_ts`
and `after_ts` bound opposite ends of one window, both **exclusive**,
and they compose — send both to fetch a bounded slice. Rows always come
back **newest-first**, whichever cursor you used; `after_ts` changes
*which* messages you get, not their order. (The websocket resume replay
is the opposite, oldest-first — do not share a rendering path between
the two without re-sorting.)

- `next_before_ts` is the timestamp of the **oldest** row on the page —
  page backwards into history with it.
- `next_after_ts` is the timestamp of the **newest** row — poll forwards
  for new messages with it, which is how a client catches up without a
  socket.

Both are `null` on an empty page.

### Moderation (app-scoped, despite the `/admin/` prefix)

| Endpoint | Auth | Body |
|---|---|---|
| `POST /admin/chat/list-messages` | **Manager** on the app | `{app_tid, room?, limit?, before_ts?, include_deleted?}` |
| `POST /admin/chat/delete-message` | **Manager** on the app | `{app_tid, tid}` — soft delete, idempotent (`already_deleted` / `not_found`) |
| `POST /admin/chat/set-room-config` | **Designer** on the app | `{app_tid, room, min_level?, scope_attrs?}` — omitting both deletes the room config |
| `POST /admin/chat/get-room-config` | **Designer** on the app | `{app_tid, room}` → `data: {app_tid, room, configured, min_level, scope_attrs}` |

`min_level` ∈ `Reader | Editor | Designer | Manager`
(`chat_room_level_invalid`); `scope_attrs` must be a flat string map
(`chat_room_scope_attrs_invalid`); an empty room name is
`chat_room_required`. Setting a room's config is Designer-gated —
deliberately a higher bar than day-to-day moderation.

> **Read the config before you write it — `set-room-config` is a
> partial set over a value you cannot otherwise see.**
>
> Send only `min_level` and the room keeps its `scope_attrs`. Send
> **neither** field and the whole room entry is deleted, scope binding
> included. Until `get-room-config` existed, nothing could show an
> operator that a `scope_attrs` was there at all — so an editor screen
> was writing over state it had no way to display, and a "clear this
> field" gesture could silently drop a scope binding somebody depended
> on.
>
> `configured` is reported separately from the values on purpose: a room
> with no entry and a room explicitly configured to `Reader` resolve to
> the same effective level, and only the second one has anything for a
> "Remove config" button to destroy. `min_level` is the **raw stored
> value** — it is `null` on an unconfigured room rather than being
> resolved to the `Reader` default, so you can tell the two apart.
> `scope_attrs` is `{}` when absent.
>
> The delete branch answers `data: {app_tid, room, removed: true}`.

---

## Durable operators (off by default)

> **Flag-gated.** The whole subsystem requires `TFL5_DURABLE_ENABLED` on
> the cell. With it off — the default — **every** endpoint below returns
> HTTP 200 `{"result":false,"code":"durable_disabled"}` before any auth
> or database work. Ask your operator before designing around it.

A durable operator is an addressable, stateful WASM instance identified
by `(app_tid, op_id, instance_key)`. Each message and its effects are
journalled, so after a crash the instance rebuilds its exact in-memory
state by replaying the journal **without re-firing effects**. A
session-level lease with a fencing token guarantees a single owner.

`op_id` and `instance_key` are 1–64 chars of `[A-Za-z0-9_-]`.

### POST /durable/:op_id/:instance_key/msg

**Auth:** Editor on `app_tid`.

**Body:** `{app_tid, msg?, idem_key?}`. `idem_key` makes a retry safe —
a repeat returns the original result with `deduplicated: true` instead of
re-delivering.

**Response:** `{result, data, instance_tid, timestamp}`.

**Codes:** `durable_disabled`, `instance_busy` (lease held elsewhere —
retryable), `wrong_cell` / `wrong_cell_needs_idem` /
`cell_forward_failed` (placement; supply an `idem_key` to let the
platform forward), `instance_quota`, `tick_deadline` (the guest blew its
per-message wall-clock budget).

**Two of those now carry the numbers you need to back off with.** Both
are HTTP 200 `{result:false, code, msg, data, timestamp}` envelopes:

| Code | `data` | What to do with it |
|---|---|---|
| `instance_quota` | `{live_instances, max_concurrent_instances}` | you are at the ceiling, not near it — shed or wait for instances to retire rather than retrying immediately |
| `tick_deadline` | `{tick_deadline_ms}` | the budget your guest overran, so you can size the work per message instead of guessing |

Without those figures a caller can only retry blindly, which is the one
strategy guaranteed not to help with a concurrency ceiling. Neither
carries a `retryable` flag — read the code.

### POST /durable/:op_id/:instance_key/stats

**Auth:** Reader on `app_tid`. **Body:** `{app_tid}`. Pure read — never
activates the instance. Returns `{fuel_used_total, busy_ms_total,
msgs_total, seq}`; a never-run or dead instance reports zeros with
`seq: -1`.

### Cross-app mail grants

A durable instance may address an instance in **another** app. That is
default-deny; the *recipient* app's Manager must grant the sender.

| Endpoint | Auth | Body |
|---|---|---|
| `POST /app/durable/mail-grant` | Manager on the **recipient** `app_tid` | `{app_tid, sender_app_tid, op_id?}` — idempotent (`created:false` on re-grant) |
| `POST /app/durable/mail-grant/revoke` | Manager on the recipient app | same shape; `{revoked: <count>}` |
| `POST /app/durable/mail-grant/list` | Manager on the recipient app | `{app_tid}` → `{grants:[{sender_app_tid, op_id, created_by, created_at}]}` |

Omitting `op_id` grants/revokes app-wide; revoking the app-wide grant
does not touch op-scoped ones. Self-grants are rejected.

### GET /ws/durable/subscribe

**Auth:** Reader on `app_tid`, checked before the upgrade. Requires
`TFL5_DURABLE_ENABLED` **and** the projections flag — otherwise
`durable_disabled` / `projections_disabled`.

**Query:** `?app_tid=A&rk=<resource>%1F<key>` repeated (the separator is
`U+001F`), or the single-resource form
`?app_tid=A&resource=R&key=k1&key=k2`. Mixing the two forms is a bad
request. Max 16 `(resource, key)` pairs per socket, each ≤ 512 chars;
a per-app live-key quota answers **402** `proj_keys_quota`.

**Read-only stream.** Frames: `welcome`, then a `snapshot` per
subscribed pair, then a `delta` per change
(`{type, resource, key, instance_tid, seq, doc, ts}`), plus a periodic
`heartbeat` carrying the latest `seq` per pair as a missed-delta
backstop. Rows are re-read under the caller's scope filter on every
delta, so a row that becomes invisible simply stops arriving. Anything
the client sends is refused with `read_only_stream`.

---

## Billing (provider-gated)

> **Provider-gated.** Payment providers are registered only when their
> webhook secret is present in the cell's environment. On a cell with
> none configured — the default — `POST /billing/webhook/:provider`
> answers **404 `unknown_provider`** for every provider, deliberately
> indistinguishable from a typo. The other endpoints still work: they
> record orders and return a pending order without a hosted checkout
> link. Treat "checkout succeeded" as "order recorded", not "payment
> taken".

### GET /billing/catalog

**Auth:** Anonymous. Returns active services and catalog-visible plans:

```json
{ "services": [ { "id": "...", "name": "...", "description": "...",
    "subject_kinds": ["app"],
    "plans": [ { "plan": "pro", "display_name": "Pro",
                 "price_cents": 1000, "currency": "USD",
                 "vat_rate_bps": 1000, "vat_cents": 100,
                 "total_cents": 1100,
                 "billing_period": "month", "features": {},
                 "limits": {}, "display_order": 1,
                 "self_service": true, "is_default": false } ] } ],
  "money": { "currency": "USD", "minor_units": 2,
             "vat_rate_bps": 1000, "prices_include_vat": false },
  "payment_providers": [ { "id": "binance", "settles": true,
                           "hosted_checkout": true } ] }
```

**Two traps in the money block, and both produce a wrong price on screen
if you miss them.**

- **`prices_include_vat` is `false`.** `price_cents` is the pre-tax
  figure; VAT is added on top by the same function that computes the
  invoice, and the result is already on the plan as `vat_cents` and
  `total_cents`. **Render `total_cents`** — quoting `price_cents` to a
  customer under-states what they will be billed. VAT defaults to
  1000 bps (10 %) and the arithmetic is round-half-up integer maths, so
  the platform's number and yours will only agree if you take theirs.
- **`minor_units` is not always 2.** It is **0** for zero-decimal
  currencies (VND, JPY, KRW, CLP, ISK, PYG, RWF, UGX, VUV, XAF, XOF,
  XPF, KMF, DJF, GNF, BIF) and **3** for BHD, IQD, JOD, KWD, LYD, OMR
  and TND; everything else is 2. Format every `*_cents` figure as
  `value / 10 ** minor_units`. Dividing by 100 is wrong for 23 of the
  currencies the platform can be configured with — on a VND cell it
  renders a bill 100× too small.

The cell's currency is `TFL5_BILLING_CURRENCY` (three ASCII letters; an
invalid value logs a warning and falls back to **USD**, which is also the
default).

**`payment_providers` always lists every provider**, configured or not —
so the array is not a "what can I pay with" list on its own. `settles`
is the field that answers that: it is true only when the cell can verify
that provider's signed webhook, i.e. only then can a payment through it
be recognised at all. `hosted_checkout` says whether the provider will
return a ready-made payment page; only `binance` can ever report it
true. A provider with `settles: false` still accepts a checkout call —
you get a recorded order and no way to pay it.

### POST /billing/account

**Auth:** Authenticated — always the caller's own account.

**Response `data`:** `{apps_used, user_max_apps, current_plans,
current_subscriptions, model, effective_cap, apps_created_total,
remaining, refundable_on_delete}`.

**`user_max_apps` is not the cap the server enforces**, and reading it
alone is the mistake this endpoint was extended to stop. The enforced
pair is **`effective_cap` + `model`**:

- `model: "rights"` — the account is on the consumable model. The gate
  compares `apps_created_total` against `effective_cap`, and
  `effective_cap` is the **greater** of the rights the account bought
  and any `user_max_apps` an `account` service grant confers. So a
  service grant can raise the ceiling without ever touching the rights
  balance, which is exactly why `user_max_apps` on its own tells you
  nothing.
- `model: "plan"` — the legacy tier branch, where `effective_cap` is the
  tier's concurrent cap.

**The two numbers do not even measure the same thing.**
`app_create_rights` is a **lifetime** counter — deleting an app refunds
nothing — while `user_max_apps` is a **concurrent** cap, where deleting
an app frees a slot straight away. `refundable_on_delete` is the field
that tells a UI which sentence to show, and it matches the `data` block
on the [402 refusal](#post-appupdate) so both surfaces agree.

`current_plans` is a map `service_id → plan` of active user-subject
entitlements. `current_subscriptions` is a map
`service_id → {plan, status, current_period_end}` built from
*user-subject* `subscriptions` rows excluding `canceled` ones
(`suspended` is included). It is what lets a client warn a user before
they re-buy an account plan they already hold — see
[change-plan](#post-billingsubscriptionchange-plan) for why that
warning matters.

### POST /billing/checkout

**Auth:** **Owner** on `app_tid` for `subject_type: "app"` (the
default); Authenticated + verified email for `subject_type: "user"`.

**Body:** `{subject_type?, app_tid?, service_id, plan, provider?,
idem_key?}`.

**Response:** `{order_ref, amount_cents, currency, provider,
status:"pending"}`, plus provider-specific fields (a checkout URL / QR
payload) **only when that provider is configured**. `idem_key` is scoped
per subject.

`currency` is **not** part of that conditional group: it is returned on
every checkout, configured provider or not, and it is returned on both
branches. On a fresh order it is the unit the order was recorded in; on
an idempotent replay it is read back **from the stored order**, not from
today's price sheet, so re-hitting a key after a currency change still
quotes what the customer was actually charged. `/billing/app-rights/checkout`
behaves the same way on both branches.

### POST /billing/subscription/preview-change

**Auth:** Owner on `app_tid`. **Body:** `{app_tid, service_id, plan}` —
the same body [change-plan](#post-billingsubscriptionchange-plan) takes.

**Read-only.** It opens no transaction and writes nothing, and it
refuses the same cases the apply refuses, so you can price a switch
before offering it.

**Response `data`:** `{service_id, from_plan, to_plan, cadence_change,
refund_cents, due_cents, new_period_end, net_cents, settlement,
currency, credit_balance, sufficient_credit, as_of}`.

`cadence_change` is a boolean — true when the switch also changes the
billing period. `net_cents` is signed: positive means the customer owes,
negative means they are owed. `settlement` is `"debit"` / `"credit"` /
`"none"`, derived from the sign of `net_cents`.

**`sufficient_credit` is the field that turns a 402 into a decision.**
It is `net_cents <= 0 || credit_balance >= net_cents` — that is, whether
the apply would go through. Check it and you can offer a top-up before
the customer meets `insufficient_credits`, instead of after.

### POST /billing/subscription/change-plan

**Auth:** Owner on `app_tid`. **Body:** `{app_tid, service_id, plan}`.

Prorates the switch and settles the difference against the app's credit
balance in one transaction. Returns `{old_plan, plan, net_cents,
currency, settlement: "debit"|"credit"|"none", current_period_end}`.
Insufficient balance → **402** `insufficient_credits`. A concurrent
change → `conflict`.

> **Proration is app-subject only, and the silence around that costs
> money.** Both this endpoint and `/preview-change` hard-code
> `subject_type = "app"` and sit behind an app-Owner gate. There is no
> user-subject equivalent — none is missing by oversight, there simply
> is no door.
>
> So buying an **account** plan the user already holds has to go through
> [`/billing/checkout`](#post-billingcheckout), and that endpoint never
> looks for an existing subscription: it reads the user, the price and
> the idempotency key, and nothing else. Activation then upserts the
> row, replacing the plan at **full price** and **resetting the
> period** — whatever was left of the plan being replaced is forfeited,
> silently and with no refund line anywhere.
>
> A client cannot make the server prorate this. What it can do is
> *warn*: read `current_subscriptions` from
> [`/billing/account`](#post-billingaccount), and if the service is
> already held, say so before the button is pressed.

### POST /billing/history

**Auth:** Owner on `app_tid`. **Body:** `{app_tid}`. Returns
`{subscriptions, credit_balance, paid_orders:{subscription, credit},
invoices}` — the last 20 of each list.

**A grant is not a subscription, and `subscriptions[]` carries both.**
The list is a full outer join of the entitlements the app actually has
against the billing rows that paid for them, so each row is:

`{service_id, plan, status, billing_plan, billing_status,
current_period_end, provider, provider_ref, granted_by, updated_at,
source}`

- **`plan` / `status` are what is ENFORCED.** These are what the app is
  being served.
- **`billing_plan` / `billing_status` are what was CHARGED**, and they
  are `null` when nothing was. The two pairs **can disagree** — an app
  whose billing row says `pro` while its entitlement says `demo` is
  being served demo — and both are reported rather than reconciled,
  because reconciling them would hide the discrepancy you need to see.
- **`source`** is `"subscription"` when a billing row exists and
  `"grant"` when it does not. It is computed from the join, not guessed
  from which fields are populated.
- `current_period_end` falls back to a grant's `expires_at` when there
  is no billing period, and `granted_by` names who issued a grant.

**Most plans on this platform arrive by grant, not by card** — the
platform's own note records `subscriptions` at 0 rows against
`app_services` at 813 on the dev database. A client that ignores
`source` will therefore offer "Cancel subscription" for a plan nobody
is paying for, on most of the rows it renders.

### Invoices

All Owner-gated on `app_tid`.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /billing/invoice/issue` | `{app_tid, order_ref, vat_rate_bps?}` | idempotent per `order_ref`; VAT defaults to 10 % (1000 bps) |
| `POST /billing/invoice/get` | `{app_tid, invoice_no?}` or `{app_tid, order_ref?}` | |
| `POST /billing/invoice/pdf` | same | returns `application/pdf` bytes |
| `POST /billing/invoice/email` | `{app_tid, invoice_no?, order_ref?, resend?}` | `{result, emailed, email, invoice_no}` — see below |

`issue` also reports `e_invoice`. No tax-authority e-invoice connector
ships with the platform, so on a stock deployment that field is always
`"not_configured"`.

**`/billing/invoice/email` has five outcomes and one of them is a
failure.** `email` is one of `"sent"`, `"not_configured"` (no mailer
wired on the cell), `"no_owner_email"`, `"already_emailed"` (idempotent
no-op) or `"send_failed"`. Four of those ride in a **success** envelope
(`result: true`), because "there was no mailer" and "it had already gone"
are both normal answers. **`send_failed` is not**: the mailer refused the
message, so the receipt was not sent, and the reply is
`result: false` with `code: "send_failed"` alongside the same `email`
field. A client that only reads `email` still works; one that reads
`result` now learns something it previously could not.

Unlike the rest of this area, that response is **flat** —
`{result, emailed, email, invoice_no, timestamp}` with no `data`
wrapper, plus `code` and `msg` on the failure branch.

### Credits

| Endpoint | Auth | Body |
|---|---|---|
| `POST /billing/credits/packs` | Authenticated | none → what is buyable right now |
| `POST /billing/credits/checkout` | Owner on `app_tid` | `{app_tid, pack_id, provider?, idem_key?}` |
| `POST /billing/credits/balance` | Owner on `app_tid` | `{app_tid}` → `{balance}` |
| `POST /billing/credits/ledger` | Owner on `app_tid` | `{app_tid, before_id?, limit?}` |

#### POST /billing/credits/packs

**Auth:** signed in. No body is read at all — the handler takes no
payload. Returns `{packs:[{id, credits, price_cents, valid_from,
valid_to}], currency}`; `valid_to` is null for an open-ended offer.

Its sale-window predicate is the same one checkout applies, so **the
list is exactly the set checkout will accept** — a screen built from it
cannot offer a pack the server then refuses.

**An empty `packs` array is a real answer, not an error.** The platform
seeds no pack, deliberately: what a credit costs is a business decision
and a made-up default would be a wrong price shipped quietly. Until an
operator configures one, credits are unbuyable and every checkout
answers `pack_not_buyable`.

#### POST /billing/credits/checkout

**Auth:** Owner on `app_tid`. **Body:** `{app_tid, pack_id, provider?,
idem_key?}`.

**The buyer no longer prices their own purchase.** `credit_amount`,
`amount_cents` and `currency` are **not accepted** — both the quantity
and the price come from the `credit_packs` row named by `pack_id`, and
both are snapshotted onto the order, so a later price edit cannot
retro-change an order already placed. An unknown, inactive or
out-of-window pack is **400** `pack_not_buyable`.

> **`pack_id` is required and has no default, and an old client fails
> loudly on purpose.** A request still carrying the retired
> `{credit_amount, amount_cents}` body is rejected during JSON
> deserialisation — *before* the handler runs — rather than falling
> through to pack 0 or to the caller's own price.
>
> That rejection is **not a platform envelope**. It is the framework's
> own **HTTP 422** with a `text/plain` body
> (`Failed to deserialize the JSON body into the target type: missing
> field \`pack_id\``): no `result`, no `code`, no `msg`, no
> `timestamp`. It looks like no other error in this document, and a
> client that parses every response as JSON will fail on the parse
> rather than on the field. Handle a non-JSON 422 as "my request body is
> the wrong shape".

**Response `data`:** `{order_ref, credit_amount, amount_cents, pack_id,
currency, provider, status:"pending"}`.

**Replaying an `idem_key` returns a narrower object.** The idempotent
branch answers `{order_ref, credit_amount, amount_cents, pack_id,
provider, status, idempotent:true}` — it gains `idempotent` and, unlike
every other checkout in this section, **omits `currency`**. Do not read
`currency` unconditionally off this endpoint; fall back to
`money.currency` from [`/billing/catalog`](#get-billingcatalog) when the
replay branch fired.

#### POST /billing/credits/ledger

**Auth:** Owner on `app_tid`. **Body:** `{app_tid, before_id?, limit?}`
— `limit` clamps to 1..=200, default 50. Page backwards with
`before_id`.

**Response `data`:** `{entries:[{id, delta, reason, ref, balance_after,
created_at}], has_more}`.

- `delta` is signed. `reason` is **never null** — the server substitutes
  `"unknown"` rather than emit a hole — while `ref` *is* nullable.
- **`balance_after` is returned as stored, never recomputed.** It is the
  balance the platform recorded at the time of the entry, so a ledger
  that does not sum to the current balance is evidence of a real
  discrepancy rather than a rendering artefact. Do not "fix" it by
  re-accumulating `delta` client-side; that would hide exactly the fault
  the column exists to expose.
- `has_more` is a heuristic on the id floor, not a lookahead — it can
  read `true` on a page that turns out to be the last one. Treat an
  empty next page as the end.

### App-creation rights

| Endpoint | Auth | Body |
|---|---|---|
| `POST /billing/app-rights/packs` | Authenticated | none → `{packs:[{id, quantity, unit_price_cents, pack_total, valid_from, valid_to}], balance:{app_create_rights, apps_created_total, remaining}}` |
| `POST /billing/app-rights/checkout` | Authenticated + verified email | `{pack_id, idem_key?}`; an out-of-window pack → `pack_not_buyable` |

This balance is what `/app/update` spends when creating an app.

### POST /billing/webhook/:provider

**Auth:** none — the request is authenticated by an HMAC signature over
the **raw** body, per provider. Idempotent on `(provider, event_id)`.

Replies: 404 `unknown_provider` (unknown **or** unconfigured), 401
`bad_signature`, 400 `malformed`, 500 `record_failed` /
`activation_failed` / `topup_failed` / `app_rights_topup_failed`, and on
success 200 `{result:true, deduped, status}`.

### POST /billing/refund

**Auth:** **platform-admin** — never self-service.

Reverses tfl5's own ledger for a paid order (cancels the subscription,
suspends the grant, voids the invoice, or claws back credits). It does
**not** move money: the response always reports
`money_refund: "not_configured"`, and returning funds to the customer is
an out-of-band operator action. Claw-back is clamped to the balance
actually held, and any shortfall is reported rather than hidden.

---

## Service entitlements

A parallel, token-based way to grant a capability without an ACL edit.

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `POST /service/list` | Authenticated | `{}` — a JSON body is required to parse, its contents are ignored | `data` is a **bare array** of `{id, name, subject_kinds[], plans[]}` for active services |
| `POST /service/redeem` | Authenticated **plus** ownership of the subject: a `user`-subject token must be your own account; an `app`-subject token needs **Owner** on that app | `{token}` | `data: {service_id, plan, subject_type, subject_id}` |

On `/service/list`, `plans[]` is a sorted array of plan names (strings),
not plan objects — for prices and features use
[`/billing/catalog`](#get-billingcatalog).

**Both answer a missing session unusually.** Instead of the 401
`isSignout` envelope, they return **HTTP 200**
`{"isSignout": true, "result": false}` — note `result` is **false**
here, where the other wire-compat handlers send `true`. Branch on
`isSignout`, not on the status and not on `result`.

Redemption never trusts the identity inside the token — authorization is
re-derived from the authenticated caller. Codes:
`entitlement_token_not_configured` (the cell has no signing key —
minting and redemption are both off), `entitlement_token_invalid`,
`entitlement_token_subject_mismatch`, `entitlement_subject_unsupported`,
`entitlement_plan_unknown`, `entitlement_token_unusable` (unknown,
already redeemed, or revoked).

The matching mint/revoke/catalog endpoints are
[platform-operator only](#platform-operator-endpoints-admin).

---

## License & platform info

### POST /license

**Auth:** Authenticated. Body: `{}` or `{app_tid}`. Returns user
license tier + (when `app_tid` given) per-app license + headroom.

### POST /licenses/catalog

**Auth:** Anonymous. Body: `{target?: "app"|"user"|"all"}` (target
reserved for future use). Returns the catalog of visible license
tiers (replica-safe).

### POST /licenses/usage

**Auth:** Authenticated. Body: `{}`. Returns per-user + per-app usage
+ caps.

### POST /licenses/preview-upgrade

**Auth:** Authenticated.

**Body:** `{target: "user"|"app", requested_tier: "...", app_tid?}`
(`app_tid` required for `target == "app"`).

**Response data:** `{current:{...}, after:{...}, delta:{...}}` —
dry-run, no DB writes.

### POST /licenses/setup-tenant

**Auth:** Authenticated AND the first-registered user (sole Manager of
`tfl5-admin`).

**Body:** `{wanted_user_tier?: "free|pro|..."}`. Idempotent flip from
`demo` to the wanted tier, gated by `self_service_max`. Body without
`wanted_user_tier` returns current state.

### POST /license/redeem

**Auth:** Authenticated. **Body:** `{token}`.

Redeems a signed license token minted by the operator. The token is
bound to one account — `claims.sub` must be the caller
(`license_token_subject_mismatch`). Redemption stamps the token used and
flips the account's tier in one transaction, so every existing quota
check picks the new tier up immediately.

**Codes:** `license_token_not_configured` (this cell has no signing key,
so neither minting nor redemption is available), `license_token_expired`,
`license_token_invalid`, `license_token_subject_mismatch`,
`license_token_unknown`, `license_token_revoked`,
`license_token_already_redeemed`, `license_token_race`.

### POST /license/my-tokens

**Auth:** Authenticated. Lists the caller's own license tokens (max 50).

> Two token systems coexist: these HS256 **license tokens** (they change
> a *tier*) and the newer signed **entitlement tokens** used by
> [`/service/redeem`](#service-entitlements) (they grant a *service*).
> They use different crypto and different endpoints — don't mix them up.

### GET /platform/info

**Auth:** Anonymous — the sign-in page needs it before any cookie exists.

**Query:** `?app_tid=a-…` (optional) returns that app's own OAuth client
ids where it configured them, instead of the platform-global ones.

**Response:**
```json
{ "test_subdomain_base":     "...",
  "google_client_id":        "...",
  "google_allowed_origins":  ["https://app.example.com"],
  "microsoft_client_id":     "...",
  "telegram_bot_username":   "...",
  "sso_authority_host":      "...",
  "turnstile_enabled":       false,
  "turnstile_site_key":      null }
```

Every field except `google_allowed_origins` and `turnstile_enabled` may
be `null` when the operator has not configured it.
`google_allowed_origins` is always an array (possibly empty);
`turnstile_enabled` is always a boolean. Note the two Turnstile fields
are independent: `turnstile_enabled` can be `true` while
`turnstile_site_key` is `null` on a half-configured cell, and you cannot
render the widget in that state.

> **`google_allowed_origins` exists so a sign-in page can refuse to
> offer a button that will fail.** Google enforces its own per-client
> origin allowlist. A host that is not on it renders the Google button
> perfectly, reports itself ready, and then answers **403 on click** —
> the failure arrives from Google, not from tfl5, so no platform error
> code and no platform status will tell you about it. There is nothing
> the server can reject on your behalf.
>
> Use the list the way the platform's own sign-in page does: if it is
> non-empty and the current origin is not in it, mark Google
> **unavailable** and point the user at an origin that works, rather
> than rendering a button that 403s.
>
> The case that hits this hardest is multi-tenant test hosts. Every app
> gets `<app_tid>.<test_subdomain_base>`, which is a distinct origin per
> app and therefore needs to be covered by the operator's allowlist —
> one entry per app, or a wildcard the provider accepts.
>
> The values are normalised on the way out: lower-cased, trailing
> slashes stripped, empties dropped. Compare against a
> similarly-normalised origin. And note the array is forced **empty**
> when you passed an `app_tid` whose app brought its own
> `google_client_id` — the operator's list does not apply to somebody
> else's OAuth client, so an empty array there means "not applicable",
> not "no restriction".

### GET /platform/version

**Auth:** Anonymous. `{service, cell_id, git_sha, built_at,
version_source}` — one GET to answer "what build is this cell running?".

### GET /livez

**Auth:** Anonymous. A cheap liveness probe that touches no database:
always 200 while the process is serving, including mid-drain. Body:
`{ok, service, cell_id, accepting}` — `accepting` is informational and
does not change the status. This is what a load balancer should probe.

### GET /healthz

**Auth:** Anonymous. Deep readiness — queries the database, so it is the
right probe for "can this cell serve requests?" and the wrong one for
"is the process alive". `?include=version` adds `git_sha`, `built_at`
and `version_source`; `?include=metrics` adds pool/in-flight counters.

**Response (200):**
```json
{ "ok": true, "service": "tfl5", "cell_id": "default",
  "in_flight": 0, "cell_status": "live",
  "pg": { "primary_healthy": true, "replicas_total": 0,
          "replicas_healthy": 0 } }
```

**Response (503):** when draining OR the primary is down OR every
configured replica is down. Draining bodies carry
`code: "service_draining"` and `drained_at`.

---

## Platform-served browser assets

The platform serves the browser libraries a published page needs, from
its own origin. Nothing here needs auth.

### GET /_tfl5/vendor/:file

Third-party browser libraries, **served by the platform itself** —
compiled into the binary, not fetched from a CDN at runtime.

This is why it exists: a CDN is a third party on the critical path of
code running inside your origin. It can serve a different build than the
one your code expects, drop a pinned version (that has happened, and it
took a sign-in flow down), go dark, and see every one of your visitors'
IP addresses. Because the bytes ship inside the same artifact as the
code that references them, a deploy can never land new code against
stale assets, and a rollback takes both back together.

**Consequences you can rely on:**
- **A published tenant page that contains a chart loads Apache ECharts
  from `/_tfl5/vendor/echarts-<version>.min.js`. There is no CDN request
  and no external `script-src` needed.**
- The path is host-independent — the same absolute URL resolves on every
  bound domain, which is what a published page needs since it cannot
  know which origin it was published on.
- The version is in the filename, so responses carry a one-year
  immutable cache header; a version bump changes the URL.
- Lookup is an exact match against a fixed table — no filesystem is
  touched, and an unknown name is a bare 404 that never echoes input.

**What is served.** A fixed, versioned set — currently Apache ECharts
(charts), a QR-code renderer, MSAL (Microsoft sign-in) and CodeMirror 5
with a few language modes. Filenames carry the version
(`echarts-6.1.0.min.js`, `codemirror-5.65.16.css`, …), so read the exact
name from the page the platform generates rather than hard-coding one:
a version bump changes the URL by design. Requesting a name that is not
in the set is a 404 — this route can only ever serve what the build
shipped.

Two provider widgets are deliberately **not** self-hosted, because they
only work when loaded from the provider's own origin: Google Identity
Services and the Telegram login widget.

### GET /sdk.js · /sdk.mjs · /sdk-ui.js · /sdk-ui.mjs

The browser build of the JavaScript SDK, also baked into the binary, so
`/sdk.js` always matches the SDK version the running build was made
from. `/sdk.js` is a classic script that defines `window.TFL5`;
`/sdk.mjs` is the ESM build. The `-ui` pair is a small optional DOM
helper (`window.tfl5ui` / named ESM exports) kept separate so the core
stays DOM-free. Served as JavaScript with a short (5-minute) cache so a
deploy is picked up promptly.

### POST /security/csp-report

**Auth:** Anonymous — browsers post these without credentials. Accepts
any JSON body shape (both the classic `{"csp-report": …}` form and the
Reporting-API array) and always answers **204 No Content**, so nothing
appears in the user's console. The report is recorded as an audit event.

---

## Error codes

Every error renders to the unified envelope (see error handling):
```json
{ "msg": "...", "code": "...", "timestamp": 1700000000000 }
```
plus `isSignout:true` for `Unauthorized`.

The `code` values below are grouped by the two mechanisms that produce
them, because the mechanism determines the HTTP status.

**A. Platform error variants** — a fixed status per variant:

| `code` | HTTP | Meaning |
|---|---|---|
| `not_found`      | 200 | the addressed row does not exist (or you may not see it) |
| `access_denied`  | 200 | signed in, not permitted |
| `unauthorized`   | 401\* | no/expired session; body carries `isSignout` |
| `bad_request`    | 400\*\* | generic rejection |
| `rate_limit_exceeded` | 429 | + `Retry-After` header |
| `internal`       | 500 | server fault; the real cause is never echoed |

\* 200 if the operator set `TFL5_LEGACY_UNAUTHORIZED_200=1`.
\*\* 200 if the operator set `TFL5_LEGACY_BADREQUEST_200=1` — this also
applies to every specific code in group B below that is marked **400**.

**B. Specific codes.** Most ride on the bad-request variant and are
therefore **HTTP 400**; the rest are handler-authored HTTP 200 envelopes
(`{result:false, msg, code}`) or a dedicated status.

| `code` | HTTP | Where it comes from |
|---------------------------------|------|---------------------|
| `auth_invalid_credentials`      | 200  | `/login` failure (opaque — no user enumeration) |
| `validation_invalid`            | 200  | `/reg` missing fields / bot-check fail; several validation paths elsewhere |
| `validation_password_short`     | 400  | `/reg` password < 6 chars |
| `validation_username_taken`     | 200  | `/reg` duplicate username |
| `validation_email_taken`        | 200  | `/reg` or `/user/email/add` — address already known |
| `validation_email_primary`      | 400  | `/user/email/remove` on the primary address |
| `validation_email_unverified`   | 400  | `/user/email/promote-primary` on an unverified address |
| `email_not_verified`            | 400  | owner-only email gate on a write |
| `has_password` / `totp_required`| 400  | `/user/set-password` |
| `password_required` / `owns_apps` / `no_pending_erasure` | 400 | `/user/data/erase*` |
| `twofa_not_enrolled` / `twofa_not_confirmed` / `twofa_invalid` / `twofa_already_confirmed` | 400 | `/user/2fa/*` |
| `twofa_locked`                  | 429  | `/user/2fa/verify` after 5 failures in 15 min |
| `quota_exceeded`                | **402** | `/app/update` create — the account's app allowance is spent. `data.cap` is `app_create_rights` (`{rights, created, remaining, refundable_on_delete:false}`) or `user_max_apps` (`{max, used, refundable_on_delete:true}`) |
| `app_update_no_acl_fields` / `app_update_no_nested_acls` | 400 | ACL fields sent to `/app/update` |
| `acl_array_too_large`           | 200  | ACL array over 5000 entries |
| `unknown_acl_bucket`            | 200  | `/app/acl/set` · `/revoke` bad bucket name. **Not raised by `/app/acl/bulk-import`** — there an unknown key is silently dropped and the call answers `result:true`; verify with `/app/acl/list` |
| `acl_token_unknown`             | 200  | an ACL entry that names nobody — no user, role or group resolves it. Carries `unknown[]` listing the offenders. Only entries the call **adds** are checked, so an array already holding historical junk still saves; `G_author` and empty strings are skipped |
| `user_not_found`                | 200  | `/app/member/set-direct-grants` **granting** to a tid/username that does not exist. Revokes deliberately skip the check, so a deleted account's access can still be stripped |
| `query_too_short`               | 200  | `/app/member/search` with fewer than 2 characters after trimming |
| `owner_protected`               | **409** | `/app/member/remove` on the app author — a state to change (transfer ownership), not a permission to be granted |
| `config_patch_empty` / `config_too_large` | 400 / 200 | `/app/config/patch` |
| `quota_app_max_storage`         | 400  | app or owner storage cap — `/app/file/upload` · `/save` **and `/app/f3/upload`**, which charges ciphertext bytes. One code for both caps; only `msg` says which |
| `file_write_shadowed_by_snapshot` | 409 / — | `/app/file/upload` · `/save` · `/del` · `/rename` writing to `release` while a site snapshot is live. Normally a `warnings[]` entry on a **successful** call; a 409 refusal only under `TFL5_REFUSE_SHADOWED_FILE_WRITE=1` |
| `file_extension_not_allowed`    | 400  | upload/save — extension not on the allowlist |
| `file_too_large`                | 400 / 200 | one code, two different caps: **400** on a write over 50 MiB (52,428,800 B) — `/app/file/upload` · `/save` · `/app/site/put` · a bundle entry; **200** on `/app/file/get` over 10 MiB (10,485,760 B) |
| `upload_request_too_large`      | 400  | the whole HTTP body exceeded its layer — 100 MiB (104,857,600 B) on `/app/file/upload`, 52 MiB (54,525,952 B) on `/app/bundle/upload`. No individual file broke its own cap |
| `folder_not_empty`              | 200  | `/app/file/del` without `recursive: true`; carries `item_count` |
| `pii_aggregate_only`            | 400  | aggregate-scope caller reading an individual row |
| `bundle_version_invalid` / `bundle_version_exists` / `bundle_version_not_found` / `bundle_no_previous` / `bundle_invalid_zip` / `bundle_too_many_entries` / `bundle_too_large` / `bundle_decompress_failed` | 400 | `/app/bundle/*` |
| `bundle_is_live` / `bundle_is_rollback_target` / `bundle_not_found` / `app_not_found` | 400 | `/app/bundle/delete` — the version is serving, is the rollback target, or does not exist |
| `draft_disk_missing` / `no_previous_release` | 200 | `/app/release` `/rollback` guards |
| `resource_not_found`            | 200  | bad `resource_tid` / `resource_ma` |
| `resource_referenced_by_link`   | 400  | `/app/resource/del` — a live `link`/`multilink` field points at it |
| `resource_not_deleted`          | **409** | `/app/resource/orphan-drop` on a live resource — soft-delete it first |
| `field_validation_failed`       | 400  | a schema validator rejected the value |
| `link_resource_not_found` / `link_target_not_found` | 400 | a `link`/`multilink` value points nowhere |
| `hook_validation_failed`        | 400  | a declared `require_fields` hook rejected the payload |
| `hook_invalid_shape`            | 400  | resource create/update — bad `hooks[]` entry |
| `hook_reject`                   | 400  | a JS code hook called `ctx.reject(...)` |
| `wasm_rejected` / `wasm_limit_exceeded` / `wasm_module_invalid` / `wasm_version_exists` / `wasm_version_not_found` / `wasm_op_id_invalid` / `wasm_version_invalid` | 400 | WASM operators |
| `where_invalid_key` / `where_too_many_keys` / `where_empty_array` / `where_invalid_array_value` / `where_null_value` / `cannot_filter_encrypted_field` / `cannot_filter_nested` | 400 | `/app/doc/list` filter |
| `offset_too_deep` / `cursor_invalid` | 400 | `/app/doc/list` paging |
| `batch_too_large` / `batch_empty` | 400 | `/app/doc/create-batch` |
| `match_on_required` / `match_on_too_many_keys` / `match_on_invalid_key` / `match_on_invalid_value` / `match_on_data_mismatch` / `match_on_ambiguous` | 400 | `/app/doc/upsert` |
| `csv_invalid` / `xlsx_invalid` / `xlsx_empty` / `mapping_invalid` / `import_too_large` | 400 | `/app/doc/import*` |
| `scope_not_configured`          | 400  | scope enforced but the resource has no `field_map` entry |
| `scope_field_map_invalid` / `scope_bindings_invalid` / `scope_bindings_patch_invalid` / `scope_bindings_patch_invalid_value` | 400 | `/app/scope/set` |
| `scope_form_required` / `scope_room_required` | 400 | scoped caller browsing across forms/rooms |
| `share_not_found`               | 200  | `/app/share/revoke` — already gone |
| `signed_url_expired`            | 410  | `GET /_signed/:token` past TTL |
| `signed_url_invalid`            | 403  | `GET /_signed/:token` bad signature |
| `public_form_not_configured` / `public_form_unknown_field` / `public_form_field_required` / `public_form_field_too_long` / `public_form_field_invalid_email` / `public_form_too_many_fields` / `public_form_rate_limited` / `public_form_quota_full` / `public_form_schema_invalid` / `public_form_scope_attrs_invalid` | 400 | public forms |
| `chat_room_required` / `chat_room_level_invalid` / `chat_room_scope_attrs_invalid` | 400 | chat room config |
| `email_dkim_not_configured`     | 400  | `/app/email/send` — the `from_domain` you named has no DKIM key on this app (or you named none and the app has no key at all) |
| `email_invalid_recipient`       | 400  | `/app/email/send` — a `to[]` entry is not a valid address |
| `domain_quota_reached`          | **402** | `/app/domain/preview` · `/add` — `licenses.domain_max_per_app` is spent. A hard status on purpose: answering 200 here let an automated pipeline read "fine" and go on to make a DNS change that could never work |
| `quota_reached`                 | 200  | `/app/domain/preview` · `/add` — a *delegation* grant's `max_subs` is spent, not the app's own cap. Remediable by asking the parent owner. On `/app/domain/request` the same condition degrades to a 400 `bad_request` and this code is dropped |
| `private_needs_request`         | 200  | `/app/domain/preview` · `/add` under a `private` parent with no whitelist entry — the entry point to [bind requests](#bind-requests-asking-a-parent-owner-for-permission) |
| `license_tier_required`         | 200  | operator/WASM tier too low |
| `tier_not_found` / `bad_target` / `missing_app_tid` | 200 | `/licenses/preview-upgrade` |
| `not_first_user` / `no_self_service_tier` / `license_tier_not_self_service` | 200 | `/licenses/setup-tenant` |
| `license_token_*`               | 200  | `/license/redeem` — see that endpoint |
| `entitlement_token_*` / `entitlement_plan_unknown` / `entitlement_subject_unsupported` | 200 | `/service/redeem` |
| `insufficient_credits`          | 402  | credit-settled plan change |
| `pack_not_buyable` / `conflict` | 400  | billing |
| `unknown_provider` / `bad_signature` / `malformed` | 404 / 401 / 400 | `POST /billing/webhook/:provider` |
| `durable_disabled` / `projections_disabled` | 200 | durable subsystem switched off |
| `instance_busy` / `wrong_cell` / `wrong_cell_needs_idem` / `cell_forward_failed` / `instance_quota` / `tick_deadline` | 200 | durable message delivery |
| `proj_keys_quota`               | 402  | `/ws/durable/subscribe` key quota |
| `token_scope_denied`            | 403  | a service token whose `scopes` do not cover the request path; `data:{path, scopes}` |
| `token_scope_unavailable`       | 503  | the scope gate could not read the token's scopes — fail-closed, retry |
| `mtls_required`                 | 403  | operator endpoint reached on the wrong port |
| `twofa_enrolment_required` / `twofa_required` | 403 | operator endpoints when the cell mandates 2FA |
| `service_draining`              | 503  | node is draining |

Match on `code`, not on `msg` — messages are reworded and localised, and
some are Vietnamese.

---

## Platform-operator endpoints (`/admin/*`)

These are **not** part of the app-developer API. They exist for whoever
runs the tfl5 cell, and are listed here only so you can recognise them
and know they are gated.

**The gate.** Almost every `/admin/*` route calls a platform-admin check:
the request must name the platform-admin app in its body **and** the
caller must be a Manager of that one app. Naming any other app is
answered `unauthorized`, deliberately without revealing whether the
platform-admin app exists. Being a Manager of *your own* app grants
nothing here.

**Two extra layers an operator may switch on:**
- **2FA** (`TFL5_REQUIRE_ADMIN_2FA`) — every `/admin/*` path then
  requires a confirmed 2FA enrolment plus a fresh `/user/2fa/verify`
  step-up: **403** `twofa_enrolment_required` / `twofa_required`.
  Bearer service tokens bypass this (they cannot do TOTP).
- **mTLS** — the four cluster-lifecycle routes
  (`/admin/cell/{drain,resume}`, `/admin/version/{apply,apply-rolling}`)
  can be restricted to a mutually-authenticated port: **403**
  `mtls_required` on the plain port.

**Surface, by area** (all POST):

| Area | Routes |
|---|---|
| Audit | `/admin/audit/list`, `/admin/audit/get`, `/admin/audit/summary`, `/admin/audit/verify` (walks the sealed audit chain and reports tampering) |
| Tenancy inventory | `/admin/apps/list`, `/admin/users/list`, `/admin/domain/list`, `/admin/domain/audit/list`, `/admin/domain/recheck` |
| Licensing | `/admin/license/set`, `/admin/license/issue`, `/admin/license/token/{list,revoke}`, `/admin/license/request/{list,approve,reject}` |
| Entitlements | `/admin/service/{catalog,upsert}`, `/admin/service/plan/{upsert,delete}`, `/admin/service/token/{issue,list,revoke}`, `/admin/service/grants/list` |
| App-creation rights | `/admin/app-rights/{grant}`, `/admin/app-rights/pack/{list,upsert}` |
| Service tokens | `/admin/token/{mint,list,revoke}` |
| Global groups | `/admin/group/{list,create,edit,del}` — groups are cluster-wide, so creating one is an operator action |
| Roles (read-only, cross-app) | `/admin/role/list-all`, `/admin/role/by-member` |
| Operator invocations | `/admin/operator/invocations` |
| Jobs & outbox | `/admin/jobs/{list,get,retry,cancel}`, `/admin/outbox/{list,get,summary,replay,reconcile}` |
| Cells & versions | `/admin/cell/{list,register,status,drain,resume}`, `/admin/cell/capacity/{compute,snapshot}`, `/admin/version/{current,cells,incoming,upload,apply,apply-rolling,delete-incoming}` |
| Storage & keys | `/admin/recompute-storage`, `/admin/storage/{backfill-per-app,drop-per-resource}`, `/admin/docs/encrypt-by-level`, `/admin/master-key/{rotate-start,backfill-start,rotation-status,abort}` |
| Platform config | `/admin/platform/dns`, `/admin/health/check-test-wildcard`, `/admin/cache/stats`, `/admin/email/{postfix-config,ingest-eml}` |
| Migration helpers | `/admin/bundle/sweep-legacy` |

**`/admin/*` routes that are NOT platform-admin.** These gate on an app
you name in the body, so an ordinary app Manager can call them for their
own app:

| Route | Gate |
|---|---|
| `/admin/app/storage/migrate` | Manager on the target `app_tid` |
| `/admin/tid/decode` | Manager on the target `app_tid` |
| `/admin/public-form/list` | Manager on the target `app_tid` |
| `/admin/public-form/set-config` | Designer on the target `app_tid` |
| `/admin/chat/{list-messages,delete-message}` | Manager on the target `app_tid` |
| `/admin/chat/set-room-config` | Designer on the target `app_tid` |
| `/admin/bundle/sweep-legacy` | Manager on the target `app_tid` |

**Not an API at all.** `GET /internal/caddy/ask` exists for a
co-located TLS terminator to ask whether a hostname should get a
certificate. It has no application-level auth and is expected to be
bound to loopback. It is not part of the app-developer API and should
not be reachable from outside the host. `GET /metrics` is likewise
operator-facing: it answers only to loopback or to a platform Manager,
and an operator can restrict it to loopback outright.
