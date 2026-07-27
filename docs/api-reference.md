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
  | Rate limited | **429** | `{result:false, code:"rate_limit_exceeded"}` + `Retry-After` |
  | Server error | **500** | `{result:false, msg:"internal error", code:"internal"}` — the real cause is never echoed |

  Two operator escape hatches restore the legacy behaviour during a
  migration window: `TFL5_LEGACY_BADREQUEST_200=1` (400 → 200) and
  `TFL5_LEGACY_UNAUTHORIZED_200=1` (401 → 200). Because of these, and
  because `access_denied` / `not_found` are 200 by design, a correct client
  checks `result` + `code` **and** the status — not the status alone.
- **Soft rejections.** Independently of the table above, many handlers
  return HTTP 200 with `{"result": false, "msg": ..., "code": ...}` for
  business-rule failures (quota full, folder not empty, duplicate name,
  nothing-to-publish). These are normal outcomes, not transport errors.
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
- **Signout envelope — two shapes.** Most handlers answer **401** +
  `{"isSignout": true, "result": true, "code": "unauthorized"}`. A few
  wire-compat handlers — `/user`, `/app/list`, and `/app/update`'s create
  branch — instead answer **HTTP 200** with a bare
  `{"isSignout": true, "result": true}` and no `code`. Treat `isSignout`
  as the signal, not the status.
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

**Response data:** one of `{"status":"pending"|"approved"|"expired"|"consumed"}`.
On `consumed` also returns `user: {tid, username}`.

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
emails:[{email_hash,email,is_primary,verified,added_at,verified_at}],
auth_methods[], has_password, app_count, total_used_storage, created_at,
erase_requested_at, erase_after`. PII is decrypted on the fly; fields the
server cannot decrypt come back `null`.

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
subjects. Every disclosure of *someone else's* facet writes an
access-log row; viewing your own does not. `access-log` returns at most
200 rows (default 50).

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
`code: "quota_exceeded"`.

**Body:**
```json
{
  "tid":  "a-xxx",                  // optional; presence = edit mode
  "data": {
    "name":        "string",        // required on create, ≤ 200 chars
    "description": "string",        // optional, ≤ 2000 chars
    "icon":        "data:image/...",// optional; small inline data URL
    "single_page": "index.html"     // optional SPA shell — see below
  }
}
```

`single_page` names an HTML file (relative to the app's served root).
When set, a client-routed deep link that matches no file serves that
shell instead of a 404 — HTML5-history routing for SPAs. `""` clears it
back to 404 behaviour; omitting it preserves the current value.

**ACL fields are rejected here, on both branches.** Passing
`managers`/`editors`/… (flat or nested under `acls`) fails with
`app_update_no_acl_fields` / `app_update_no_nested_acls` rather than
being silently dropped. Use [`/app/acl-set`](#post-appacl-set) or the
[member endpoints](#members--app-acl-admin).

**Response (success):** `{ result, data: <app row>, timestamp }`.

**Notes:**
- Validation soft-failures: `{"msg":"Name invalid","code":"validation_invalid"}`,
  `{"msg":"Quota exceeded","code":"quota_exceeded"}`.
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
single_page, author, license_tid`, the six ACL arrays (`managers,
designers, editors, readers, deletable, noaccess`) and joined license
info (`license: {tid, name, description, app_max_storage, user_max_apps,
user_max_total_storage}`).

An unknown or inaccessible `tid` also answers `access_denied` — by
design you cannot tell "no such app" from "not yours".

### POST /app/acl-set

**Auth:** Manager on the app.

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

**Guardrails (non-owner Manager only):**
- Cannot remove themselves from `managers`.
- Cannot add themselves to `noaccess`.

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

**Auth:** Editor on `app_tid`.

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
  required level scales with what you touch: `managers` → **Owner**;
  `designers` / `developers` → **Manager**; anything else → **Designer**.
  Omitted array names are left unchanged. Unknown array name →
  `validation_invalid`.
- `remove` refuses to remove the app's author (`code:
  "owner_protected"`) — transfer ownership first.

### Incremental ACL editing (`/app/acl/*`)

`/app/acl-set` replaces all six buckets in one shot. These are the
surgical equivalents over the same columns, all **Manager**-gated, all
subject to the same 5000-entries-per-array cap
(`acl_array_too_large`) and the same self-lockout guard (a non-owner
Manager may not remove themselves from `managers` nor add themselves to
`noaccess`).

| Endpoint | Body | Effect |
|---|---|---|
| `POST /app/acl/list` | `{app_tid}` | read all six buckets — the read counterpart `/app/acl-set` never had |
| `POST /app/acl/set` | `{app_tid, bucket, members[]}` | replace **one** bucket |
| `POST /app/acl/revoke` | `{app_tid, bucket, member}` | remove one principal from one bucket, idempotent |
| `POST /app/acl/bulk-import` | `{app_tid, grants:{managers?,designers?,editors?,readers?,deletable?,noaccess?}}` | replace the buckets you supply, preserve the rest |

Buckets are `managers, designers, editors, readers, deletable,
noaccess`; an unknown name gives `unknown_acl_bucket`. Bare role tids are
bracket-normalised on the way in, so passing `r-…` matches a stored
`[r-…]`.

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
  field can never be filtered on.
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
are bracket-wrapped (`[r-…]`) before persistence. These arrays gate
every `/app/doc/*` op on that resource. Denial is deliberately
asymmetric: **`/app/doc/list` returns an empty success page** (no
existence leak), while `/app/doc/get`, `/create`, `/update`, `/del`,
`/acl-set` and `/create-batch` return `access_denied`. Doc
create/update/delete additionally require the resource's `editors` /
`deletable`. `managers / designers / authors` are read back by
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

Only Files participate in per-row ACL, quota accounting and the trash;
bundle entries are public and quota-free by design.

### Site engine (draft → publish)

Content-addressed. Writes land in a mutable **draft**; `publish` freezes
the draft into an immutable **snapshot** and flips the app's live
pointer in one atomic step. Every endpoint is **Manager** on `app_tid`.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /app/site/put` | `{app_tid, path, kind?, content_text?, content_base64?, mime?}` | writes into the draft. `kind` is `file` (default use) or `page` (a JSON component tree). Exactly one of `content_text` / `content_base64`. Request cap 20 MB. Returns `{snapshot_id, blob_sha, size, deduped}` |
| `POST /app/site/delete` | `{app_tid, path}` | `{removed}` |
| `POST /app/site/list` | `{app_tid}` | `{entries}` — the draft |
| `POST /app/site/get` | `{app_tid, path}` | `{found, content_base64}` |
| `GET /app/site/preview` | query `?app_tid=…&path=…` (`path` defaults to `index.html`) | renders/serves the **draft**; `page` entries are rendered to HTML, files streamed with their stored type and `Cache-Control: no-store`. Not a JSON envelope |
| `POST /app/site/publish` | `{app_tid, note?}` | `{live_snapshot}`. An empty draft is refused ("nothing to publish") |
| `POST /app/site/rollback` | `{app_tid, snapshot_id}` | re-points live at an earlier snapshot |
| `POST /app/site/history` | `{app_tid}` | `{snapshots}` |
| `POST /app/site/file-history` | `{app_tid, path}` | `{versions}` — every version of one path |
| `POST /app/site/blob` | `{app_tid, sha}` | `{found, content_base64}` — fetch by content hash |
| `POST /app/site/backfill` | `{app_tid}` | one-shot import of an existing file tree into a first snapshot |

Blobs are content-addressed and reference-counted, so re-publishing an
unchanged file costs nothing (`deduped: true`).

### Bundles (versioned static releases)

A bundle is one immutable version of your whole static asset tree.
Bundle bytes do **not** count against the tenant's storage quota, and
bundle entries carry no per-file ACL — they are public.

### POST /app/bundle/upload  *(multipart)*

**Auth:** Manager on `app_tid`.

**Multipart fields:** `app_tid`, `version` (required, unique per app,
alphanumeric plus `. _ -`, ≤ 64 chars), `notes` (optional), `file` (one
`.zip`).

**Caps:** zip ≤ 10 MB; ≤ 500 entries; ≤ 50 MB uncompressed; every entry
must pass the extension allowlist.

**Response `data`:** `{tid, app_tid, version, sha256, file_count,
total_bytes, uploaded_at, original_filename}`.

**Codes:** `bundle_version_invalid`, `bundle_version_exists`,
`bundle_invalid_zip`, `bundle_too_many_entries`, `bundle_too_large`,
`bundle_decompress_failed`, `file_too_large`,
`file_extension_not_allowed`.

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
  500-entry / 50 MB-uncompressed / 10 MB-per-entry caps as
  `/app/bundle/upload`.
- `bundle_prefix`, `scope_attrs` — optional.

**Limits:** 10 MB per file, request body up to 100 MB. Extension
allowlist: HTML/CSS/JS/JSON, common images, fonts, plain text. Banned
ext → `file_extension_not_allowed`. Oversize → `file_too_large`.

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

Same caps + extension gate as `/upload`; request body up to 20 MB. One
file per call.

### POST /app/file/get

**Auth:** Reader on `app_tid` + per-row ACL. Request body up to 1 MB.

**Body:** `{app_tid, path, stage?}` (`stage` defaults to `release`).

**Response data:** `{tid, path, stage, size, mime, content_base64}`.
Files > 10 MB return HTTP 200 with `{"result":false,"msg":"file too
large; use public asset URL","code":"file_too_large",
"data":{path,size,mime,tid,max_bytes}}` — fetch those through
`/app/file/sign-url` or the public URL instead. A file the caller may
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
`{"result":false,"code":"folder_not_empty"}`). Soft-delete — the bytes
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

Two modes:
- `backup_ts` omitted or `0` → **pointer swap** back to the previous
  release version: O(1), no file copying. Returns
  `{current_release_version, previous_release_version}`; `code:
  "no_previous_release"` when there is nothing to go back to.
- `backup_ts` set → restore from that snapshot's manifest, after taking a
  safety backup of the current release.

Both take the same per-app advisory lock as `/app/release`.

---

## Roles

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
  "target_kind":     "app",              optional, currently always 'app' — see scope note
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

**Scope (today):** the WHERE clause hard-binds
`resource_type='app' AND resource_tid=$app_tid`. Only events explicitly
targeting the app row surface (ACL changes, app rename, owner transfer,
license-tier flips, version applies). Events on child resources (docs,
files, shares) carry the child's tid and **do not** appear in this feed
today. Adding `audit_log.app_tid` as a first-class column is a planned
future migration.

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

### POST /app/domain/preview

**Auth:** Owner on `app_tid`. Body: `{app_tid, domain}`.

**Response** — one of several branches:
- `already_owned: true` — this app already holds the domain.
- `auto_active: true` with `shortcut: {parent_app_tid, parent_domain}` —
  you own a parent domain, so no DNS step is needed.
- `delegation: {...}` — a parent owner has granted you sub-binding.
- otherwise DNS instructions, with the verification material nested at
  `data.verify`.

On a local-dev host the reply is `auto_active: true`.

### POST /app/domain/add

**Auth:** Owner on `app_tid`.

**Body:** `{app_tid, domain}`. There is **no** `verify_token` field —
the A-record-only contract replaced the older TXT/token handshake. A
`verify_token` sent by an older client is silently ignored. (Some
`/preview` responses still carry a legacy note telling you to send one;
disregard it.)

**Behaviour:** verifies DNS, INSERTs `domains` row with `active = TRUE`.
Quota gated by `licenses.domain_max_per_app`. Idempotent on
same-app re-add.

### POST /app/domain/list

**Auth:** Designer on `app_tid` (loosened from Owner so the Domains
tab renders). Returns rows + computed `badge` (`live | warming |
needs_recheck`) + DNS instructions for inactive rows.

### POST /app/domain/del

**Auth:** Owner on `app_tid`. Body: `{app_tid, tid}`. Hard removes the
domain row. Audit-logged.

### POST /app/domain/verify

**Auth:** Owner on `app_tid`. Body: `{app_tid, tid}`. Recovery /
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
| `POST /app/domain/request` | Owner of the requesting **app** + verified email | `{app_tid, domain, note?}` | Idempotent — resubmitting reuses the pending row and reports `already_pending`. Returns `{tid, parent_domain, requested_host, status, already_pending}` |
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

> **`host_query` is NOT the same gate as `/app/doc/list` — read this
> before you rely on it.** Two checks that `/app/doc/list` performs are
> missing on the query host call:
>
> - **Resource-level ACL.** `/app/doc/list` evaluates the resource's
>   `readers`/`editors`/`noaccess` and returns an empty list to a caller
>   the resource excludes. `host_query` does not, so that same caller
>   receives real rows through a module.
> - **PII level.** `/app/doc/list` drops rows whose scope binding grants
>   only aggregate access and masks the ones marked masked. `host_query`
>   applies the plain scope filter, so those rows arrive whole.
>
> Per-doc `readers`/`noaccess` are *not* part of this difference: in this
> platform per-doc ACL gates writes (`update`, `del`, `acl-set`), not
> reads, so `/app/doc/list` does not enforce them either. Treat a module
> as able to see any level-0 field of any row in the app that the caller
> has app-Reader on, and put anything more sensitive behind field-level
> encryption rather than behind an ACL.

### ABI (compiling a module)

The guest exports `memory`, `tfl5_alloc(i32) -> i32` and
`tfl5_invoke(i32, i32) -> i64`; the host provides `host_log` and
`host_call` under the module name `"tfl5"`. Request and response are
JSON passed over linear memory, and the ABI carries a version number.
Any language that targets WASM (Rust, TinyGo, AssemblyScript) works.
Additional per-invocation caps beyond the table above: 256 KiB per host
request payload, 4 KiB per log line, and a limit on table elements.

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
  "from_domain":"acme.com",     optional; falls back to first DKIM-
                                // configured domain for this app
  "to":         ["..."],        required, ≥ 1
  "subject":    "string",       required
  "html":       "string",       optional; html or text required
  "text":       "string",
  "reply_to":   "string"        optional
}
```

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

**Limits:** 100 MB per file. Levels: 1 = internal, 2 = confidential
(per-access audit), 3 = top-secret (per-grantee envelope).

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

**Frames are JSON text** (binary frames are refused with
`binary_unsupported`):

| Client sends | Server sends |
|---|---|
| `{"type":"ping"}` | `{"type":"pong","ts"}` |
| `{"type":"msg","text":"…"}` | `{"type":"msg","tid","from","from_user_tid","room","text","ts"}` broadcast to the room |
| — | `{"type":"welcome","username","app_tid","room","ts"}` on connect |
| — | `{"type":"error","code","msg","ts"}` |

Error codes on the socket: `invalid_json`, `unknown_type`, `empty_msg`,
`persist_failed`, `lagged` (you fell more than 128 frames behind;
recoverable), `binary_unsupported`.

A message is persisted **before** it is broadcast, and you see your own
message via the broadcast rather than a local echo. Delivery is
cross-cell.

### POST /app/chat/history

**Auth:** same gate as the socket — the room's `min_level` plus scope.

**Body:** `{app_tid, room?, limit?, before_ts?}` (`limit` 1..=200,
default 50). Returns `{messages:[{tid, from_user_tid, from, text, ts}],
next_before_ts}`, newest first. Deleted messages are never included.

### Moderation (app-scoped, despite the `/admin/` prefix)

| Endpoint | Auth | Body |
|---|---|---|
| `POST /admin/chat/list-messages` | **Manager** on the app | `{app_tid, room?, limit?, before_ts?, include_deleted?}` |
| `POST /admin/chat/delete-message` | **Manager** on the app | `{app_tid, tid}` — soft delete, idempotent (`already_deleted` / `not_found`) |
| `POST /admin/chat/set-room-config` | **Designer** on the app | `{app_tid, room, min_level?, scope_attrs?}` — omitting both deletes the room config |

`min_level` ∈ `Reader | Editor | Designer | Manager`
(`chat_room_level_invalid`); `scope_attrs` must be a flat string map
(`chat_room_scope_attrs_invalid`); an empty room name is
`chat_room_required`. Setting a room's config is Designer-gated —
deliberately a higher bar than day-to-day moderation.

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

**Auth:** Anonymous. Returns `{services:[{id, name, description,
subject_kinds, plans:[{plan, display_name, price_cents, billing_period,
features, limits, display_order, self_service, is_default}]}]}` for
active services and catalog-visible plans.

### POST /billing/account

**Auth:** Authenticated — always the caller's own account. Returns
`{apps_used, user_max_apps, current_plans}`.

### POST /billing/checkout

**Auth:** **Owner** on `app_tid` for `subject_type: "app"` (the
default); Authenticated + verified email for `subject_type: "user"`.

**Body:** `{subject_type?, app_tid?, service_id, plan, provider?,
idem_key?}`.

**Response:** `{order_ref, amount_cents, provider, status:"pending"}`,
plus provider-specific fields (a checkout URL / QR payload) **only when
that provider is configured**. `idem_key` is scoped per subject.

### POST /billing/subscription/change-plan

**Auth:** Owner on `app_tid`. **Body:** `{app_tid, service_id, plan}`.

Prorates the switch and settles the difference against the app's credit
balance in one transaction. Returns `{old_plan, plan, net_cents,
settlement: "debit"|"credit"|"none", current_period_end}`. Insufficient
balance → **402** `insufficient_credits`. A concurrent change →
`conflict`.

### POST /billing/history

**Auth:** Owner on `app_tid`. **Body:** `{app_tid}`. Returns
`{subscriptions, credit_balance, paid_orders:{subscription, credit},
invoices}` — the last 20 of each list.

### Invoices

All Owner-gated on `app_tid`.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /billing/invoice/issue` | `{app_tid, order_ref, vat_rate_bps?}` | idempotent per `order_ref`; VAT defaults to 10 % (1000 bps) |
| `POST /billing/invoice/get` | `{app_tid, invoice_no?}` or `{app_tid, order_ref?}` | |
| `POST /billing/invoice/pdf` | same | returns `application/pdf` bytes |
| `POST /billing/invoice/email` | `{app_tid, invoice_no?, order_ref?, resend?}` | `{emailed, email: "sent"\|"not_configured"\|"no_owner_email"\|"already_emailed"\|"send_failed"}` |

`issue` also reports `e_invoice`. No tax-authority e-invoice connector
ships with the platform, so on a stock deployment that field is always
`"not_configured"`.

### Credits

| Endpoint | Auth | Body |
|---|---|---|
| `POST /billing/credits/checkout` | Owner on `app_tid` | `{app_tid, credit_amount, amount_cents?, currency?, provider?, idem_key?}` |
| `POST /billing/credits/balance` | Owner on `app_tid` | `{app_tid}` → `{balance}` |

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

| Endpoint | Auth | Body |
|---|---|---|
| `POST /service/list` | Authenticated | lists services visible to the caller |
| `POST /service/redeem` | Authenticated **plus** ownership of the subject: a `user`-subject token must be your own account; an `app`-subject token needs **Owner** on that app | `{token}` |

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
{ "test_subdomain_base":  "...",
  "google_client_id":     "...",
  "microsoft_client_id":  "...",
  "telegram_bot_username":"...",
  "sso_authority_host":   "..." }
```

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
| `quota_exceeded`                | 200  | `/app/update` create — no app-creation rights left |
| `app_update_no_acl_fields` / `app_update_no_nested_acls` | 400 | ACL fields sent to `/app/update` |
| `acl_array_too_large`           | 200  | ACL array over 5000 entries |
| `unknown_acl_bucket`            | 200  | `/app/acl/set` `/revoke` bad bucket name |
| `owner_protected`               | 200  | `/app/member/remove` on the app author |
| `config_patch_empty` / `config_too_large` | 400 / 200 | `/app/config/patch` |
| `quota_app_max_storage`         | 400  | file upload/save — app or owner storage cap |
| `file_extension_not_allowed`    | 400  | upload/save — extension not on the allowlist |
| `file_too_large`                | 400 / 200 | 400 on upload; 200 on `/app/file/get` over 10 MB |
| `folder_not_empty`              | 200  | `/app/file/del` without `recursive: true` |
| `pii_aggregate_only`            | 400  | aggregate-scope caller reading an individual row |
| `bundle_version_invalid` / `bundle_version_exists` / `bundle_version_not_found` / `bundle_no_previous` / `bundle_invalid_zip` / `bundle_too_many_entries` / `bundle_too_large` / `bundle_decompress_failed` | 400 | `/app/bundle/*` |
| `draft_disk_missing` / `no_previous_release` | 200 | `/app/release` `/rollback` guards |
| `resource_not_found`            | 200  | bad `resource_tid` / `resource_ma` |
| `resource_referenced_by_link` / `resource_not_deleted` | 400 / 200 | `/app/resource/del` · `/orphan-drop` |
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
