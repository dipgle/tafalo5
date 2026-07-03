# tfl5 API Reference

> Companion to [app-builder-guide.md](./app-builder-guide.md) (concepts) and
> [acl-model.md](./acl-model.md) (auth). Endpoint reference for app
> developers + AI agents consuming tfl5 via REST.

## Conventions

- **Transport:** HTTPS, all bodies `application/json` unless noted.
- **HTTP method:** POST for every endpoint except the few GETs flagged
  inline (`/healthz`, `/auth/magic`, `/auth/vneid/callback`, `/auth/sso`,
  `/_sso/accept`, `/_signed/:token`, `/verify-email`).
- **Session:** cookie `_token` (configurable via `TFL5_COOKIE_NAME`).
  Issued by `/login`, `/auth/google`, `/auth/magic`, `/auth/qr/poll`,
  `/auth/telegram/login`, `/auth/phone/verify`, `/auth/vneid/callback`,
  `/_sso/accept`. Cleared by `/logout`.
- **Success envelope:**
  ```json
  { "result": true, "data": <object|array>, "timestamp": 1700000000000 }
  ```
- **Soft-error envelope (HTTP 200):**
  ```json
  { "result": false, "msg": "...", "code": "<code>", "timestamp": ... }
  ```
  or simply `{ "msg": "...", "code": "...", "timestamp": ... }`. Many
  validation / quota paths emit 200 + `msg` rather than a 4xx — clients
  must check `result` and `code`, not HTTP status alone.
- **Signout envelope:** when the cookie is missing/expired, most
  authenticated endpoints reply `{ "isSignout": true, "result": true }`
  (HTTP 401 by default; flip via `TFL5_LEGACY_UNAUTHORIZED_200=1`).
- **Permission tags:** Anonymous / Authenticated / Reader / Editor /
  Designer / Manager / Owner / per-doc ACL. Union semantics — see
  [acl-model.md](./acl-model.md). Owner = `apps.author` only; Manager =
  Owner ∪ `managers[]`; Designer = Manager ∪ `designers[]`; Editor =
  Designer ∪ `editors[]`; Reader = Editor ∪ `readers[]`. `noaccess[]`
  vetoes at every level. **Write-class levels also require
  `users.email_verified = TRUE`** (Reader-level reads are exempt).
- **CORS:** `TFL5_CORS_ALLOW_ORIGINS` whitelist gates credentialed
  cross-origin calls; absent → permissive non-credentialed.

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
  "email":           "string",  // required, must contain '@'
  "mobile":          "string",  // optional
  "name":            "string",  // optional
  "turnstile_token": "string"   // required IFF TFL5_TURNSTILE_SECRET set
}
```

**Response (success):**
```json
{ "result": true, "data": { "tid": "u_...", "username": "..." },
  "timestamp": 1700000000000 }
```

**Notes:**
- All validation failures return HTTP 200 with `msg` + `code` in
  (`validation_invalid`, `validation_password_short`,
  `validation_username_taken`, `validation_email_taken`).
- PII (email/name/mobile) is encrypted at rest; lookup via SHA-256
  email hash.
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
{ "result": true, "user": { "tid": "u_...", "username": "..." },
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

**Response:** sets `_token` cookie on success.
- New email → creates user (`auth_methods=['google']`, verified).
- Verified existing account with same email → auto-link.
- Unverified existing account → demands `password` to prove ownership.
  Without it: `{ "requires_password": true, "username_hint": "..." }`.

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

**Auth:** Authenticated. Returns current Telegram link metadata for the
caller (verify before use — implementation details: bot/profile fields
returned).

### POST /auth/phone/start

**Auth:** Anonymous. Phone OTP request.

**Body:** `{ "phone": "0xxxxxxx | +<country>xxxxxxx", "redirect_to": "..." }`.

**Response:** opaque success regardless of phone validity.
Includes `dev_otp` field only when `TFL5_PHONE_OTP_DEV_ECHO=true` is set
(local dev only).

**Notes — flag before use:** OTP delivery is currently a stub
(`tracing::debug!` log only). Production wiring through the operator
registry (Zalo ZNS / SMS) is pending — **(verify before use)**.
Operator id from `TFL5_PHONE_OTP_OPERATOR_ID` (default `"zalo-zns"`).

### POST /auth/phone/verify

**Auth:** Anonymous. Validates the OTP, sets `_token` cookie.

**Body:** `{ "phone": "...", "code": "6-digit", "redirect_to": "..." }`.

**Response (success):**
```json
{ "ok": true, "result": true, "user_tid": "u_...",
  "redirect_to": "/#/apps" }
```

**Notes:** 10-min TTL per OTP, max 5 attempts. New phones auto-create
a user (`auth_methods=['phone']`, placeholder username
`phone_<last4>_<rand4>`).

### POST /auth/vneid/start

**Auth:** Authenticated (only used as a user-tid resolver — operator
is per-app).

**Body:** `{ "app_tid": "...", "redirect_to": "..." }`.

**Response:** `{ result, state, authorize_url, warning?, timestamp }`.

**Notes — flag before use:** VNeID is dev-only today. The
`authorize_url` is a placeholder unless the operator config is
populated with real merchant URLs; production integration
pending — **(verify before use)**.

### GET /auth/vneid/callback?code=&state=

**Auth:** Anonymous. Validates the state, sets `_token` cookie.
Currently resolves `national_id` from the dev env var
`TFL5_VNEID_DEV_NATIONAL_ID` — **(verify before use)** for prod.

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

**Auth:** Authenticated.

**Response:**
```json
{ "result": true,
  "user": { "tid", "username", "license_tid", "app_count" },
  "platform": { "test_subdomain_base", "google_client_id",
                "telegram_bot_username" },
  "timestamp": ... }
```
Returns `{ "isSignout": true, "result": true }` if cookie invalid.

### POST /user/profile

**Auth:** Authenticated. Extended account info for the settings page.

**Response data fields:** `tid, username, license_tid,
license:{tid,name,description,user_max_apps,user_max_total_storage,
app_max_storage}, email, name, mobile, email_verified, auth_methods[],
app_count, total_used_storage, created_at`. PII decrypted on the fly.

### POST /user/change-password

**Auth:** Authenticated.

**Body:** `{ "current": "...", "new": "...", "re_new": "..." }`.

**Notes:**
- New password must be ≥ 6 chars and match `re_new`.
- Refuses for accounts without `'password'` in `auth_methods`
  (e.g. Google-only). Opaque "Current password is incorrect" on
  failure (no timing leak vs `/login`).
- Fires `auth.password.changed` audit row.

### POST /user/send-verification

**Auth:** Authenticated.

Triggers an email verification mail. Returns `{result, msg}`. Requires
`TFL5_NOREPLY_FROM` + mailler configured.

### GET /verify-email?token=...

**Auth:** Anonymous. HTML response. Flips `users.email_verified = TRUE`
when the token (24h TTL) matches the current email hash. Idempotent.

### POST /user/2fa/enroll

**Auth:** Authenticated. Always overwrites prior enrolment.

**Response data:** `{ provisioning_uri, secret_base32, backup_codes[],
confirmed: false }`. Frontend renders the URI as a QR for the
authenticator app. **The secret + backup codes are returned ONLY here;
never re-fetchable.** User must call `/user/2fa/confirm` to activate.

### POST /user/2fa/confirm

**Auth:** Authenticated. Body: `{ "code": "6-digit" }`. Activates the
enrolment when the TOTP matches.

### POST /user/2fa/verify

**Auth:** Authenticated. Body: `{ "code": "6-digit OR backup-code" }`.
Issues the `_token_2fa` cookie that unlocks admin endpoints when
`TFL5_REQUIRE_2FA_FOR_ADMIN` is on. Backup codes consume on use.

### POST /user/2fa/disable

**Auth:** Authenticated + valid TOTP. Body: `{ "code": "..." }`.
Wipes the row + drops the 2FA cookie.

### POST /user/2fa/regenerate-backup-codes

**Auth:** Authenticated + valid TOTP. Body: `{ "code": "..." }`.
Returns a fresh `backup_codes[]` array; old codes invalidated.

### POST /user/2fa/status

**Auth:** Authenticated. Returns `{ enrolled, confirmed_at,
last_used_at, backup_codes_remaining }` (verify field names before use
— pulled from `user_2fa`).

---

## Apps

### POST /app/update

Dual-purpose:
- **`tid` absent** → create new app. Owner becomes the caller.
- **`tid` present** → edit existing app.

**Auth (create):** Authenticated + email verified + license quota
(`users.app_count < license.user_max_apps`) + platform-level designer
gate.
**Auth (edit):** Manager on the app.

**Body:**
```json
{
  "tid":  "a_xxx",                  // optional; presence = edit mode
  "data": {
    "name":        "string",        // required on create
    "description": "string",        // optional
    "icon":        "data:image/..." // optional; small inline data URL
  }
}
```

**Response (success):** `{ result, data: <app row>, timestamp }`.

**Notes:**
- Validation soft-failures (200): `{"msg":"Name invalid"}`,
  `{"msg":"Quota exceeded","code":"quota_exceeded"}`.
- Side effects: `app_keys` row created (KMS-wrapped), `app.create`
  audit row, `users.app_count++` (inside `repo.create` tx).
- Full-resolution logo: upload separately to
  `<app>/assets/logo.<ext>` via `/app/file/upload`.

### POST /app/list

**Auth:** Authenticated. Returns apps where caller is `author` OR in
`managers[]`. Soft-deleted apps excluded.

**Response data:** array of `{tid, name, description, icon,
used_storage, created_at, updated_at}`, sorted by `created_at DESC`.

### POST /app/get

**Auth:** Authenticated + caller is `author` OR `managers[]` member.

**Body:** `{ "tid": "a_xxx" }`.

**Response data:** full app row including all ACL arrays
(`managers, designers, developers, editors, readers, deletable,
noaccess`) and joined license info (`license: {tid, name,
description, app_max_storage, user_max_apps,
user_max_total_storage}`). `AccessDenied` if not authorized.

### POST /app/acl-set

**Auth:** Manager on the app.

**Body:** every ACL field is optional; omitted = preserve.
```json
{
  "app_tid":    "a_xxx",   // required
  "managers":   ["..."],
  "designers":  ["..."],
  "developers": ["..."],
  "editors":    ["..."],
  "readers":    ["..."],
  "deletable":  ["..."],
  "noaccess":   ["..."]
}
```

**Guardrails (non-owner Manager only):**
- Cannot remove themselves from `managers`.
- Cannot add themselves to `noaccess`.

**Side effects:** `state.invalidate(app_tid)` busts the ACL cache;
`app.acl_set` audit row captures full after-state.

### POST /app/transfer-ownership

**Auth:** Owner only.

**Body:**
```json
{ "app_tid": "...", "new_owner_tid": "u_xxx",
  "keep_old_as_manager": false, "reason": "..." }
```

**Notes:** new owner must exist + unbanned. Flips `apps.author`, adds
new owner to `managers[]`, removes old owner from `managers[]` unless
`keep_old_as_manager: true`. Writes append-only `app_ownership_log`
row + `app.transfer-ownership` audit.

### POST /app/invite-user  *(Batch 85)*

**Auth:** Editor on `app_tid`.

**Body:**
```json
{
  "app_tid":     "a_xxx",                          required
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
  `{result:true, data: {tid:"iv_xxx", email_hash_b64:"...", status:"sent"}}`.
  When the user clicks the link, the `/auth/magic` claim handler:
  - creates the user (`email_verified=true`, `_token` cookie set),
  - looks up all unclaimed `user_invites` matching this magic_token_tid,
  - atomically adds the new user_tid to each invite's `role_tids` members
    + stamps the invite as claimed.
- **User exists (email_hash match):** do NOT send email. Add the
  existing user_tid to the listed `role_tids` immediately (idempotent
  membership append). Response:
  `{result:true, data: {tid:"iv_xxx", user_tid:"u_yyy", status:"user_already_exists"}}`.

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

**Body:** `{ "tid": "a_xxx" }`.

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
{ "app_tid": "a_xxx",
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

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`. Cancels a
caller-owned pending request.

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

**Auth:** Reader on `app_tid`. Body: `{app_tid, tid}`. Full resource
row including `hooks` JSONB and per-resource ACL arrays (`managers,
editors, designers, readers, authors, noaccess, deletable`).

### POST /app/resource/create

**Auth:** Manager on `app_tid`.

**Body:**
```json
{
  "app_tid":     "a_xxx",                  required
  "ma":          "student",                required, [a-zA-Z0-9_-]+
  "name":        "Student",                required
  "description": "string",                 optional
  "fields":      [ { "field": "...",       optional, default []
                     "name":  "...",
                     "level": 0,
                     "validator": "..." } ],
  "hooks":       [ { "type": "...", ... } ] optional, default []
}
```

**Notes:**
- `(app_tid, ma)` is unique among active resources.
- `fields[*].level` >= 1 = encrypted at rest (`data_secret`).
- Hook shape validated via `validate_hook_shape` — fails create with
  `hook_invalid_shape` on bad shape.

### POST /app/resource/update

**Auth:** Manager on `app_tid`.

**Body:** all fields optional except `app_tid` + `tid`. COALESCE-skip
semantics — omitted = preserve.
```json
{ "app_tid", "tid", "name?", "description?", "fields?", "status?",
  "sharing?", "hooks?" }
```

### POST /app/resource/del

**Auth:** Manager on `app_tid`. Body: `{app_tid, tid}`. Soft delete
(`deleted_at = now`).

---

## Docs (data rows)

### POST /app/doc/list

**Auth:** Reader on `app_tid`.

**Body:**
```json
{
  "app_tid":         "a_xxx",   required
  "resource_tid":    "r_xxx",   one of resource_tid|resource_ma required
  "resource_ma":     "student",
  "include_deleted": false,     optional
  "author":          "u_xxx",   optional filter
  "where":           { "grade": "7A" },   optional, see Filter DSL below
  "limit":           100,       optional, clamp 1..=500, default 100
  "offset":          0          optional, cap 100000
}
```

**Filter DSL (Batch 85):** `where` is a flat map of `key: value` AND'd
together. Allowed:

- **Key constraints:** must match `[a-z_][a-z0-9_]*`, declared at
  `level: 0` in the resource schema. Cap 10 keys per call.
- **Value types:** string / number / boolean → equality. Array →
  IN semantics (`data_indexed->>'key' = ANY(array)`).
- **Rejected with codes:** `cannot_filter_encrypted_field` (level≥1
  key), `cannot_filter_nested` (object value), `invalid_field_name`
  (regex mismatch), `where_too_many_keys` (>10).
- Backward compatible: omitting `where` preserves pre-Batch-85 behavior.
- **Forward-extensible** (not implemented v1): operator-aware values
  `{ "op": "gt", "value": 5 }` and logical groups
  `{ "$and": [...], "$or": [...] }` are reserved for v2.

**Response:** array of doc rows. `data_secret` (level-1+ fields) is
auto-decrypted into the unified `data` object when caller has access
to the app key. Resource-not-found returns
`{"msg":"...","code":"resource_not_found"}`.

### POST /app/doc/create-batch  *(Batch 85)*

**Auth:** Editor on `app_tid`.

**Body:**
```json
{
  "app_tid":      "a_xxx",                        required
  "resource_tid": "r_xxx",                        one of *_tid|*_ma required
  "resource_ma":  "attendance",
  "items": [                                       required, 1..=200
    {
      "data":      { ... },                       required per item
      "editors":   ["..."], "readers": ["..."],
      "deletable": ["..."], "noaccess": ["..."]
    },
    ...
  ],
  "atomic": true                                   optional, default true
}
```

**Cap:** `items.length` must be 1..=200. >200 → `{"code":"batch_too_large"}`.

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

**Side effects:**
- 1 audit_log row per batch (NOT per-doc) with count + failure summary.
- `hook_invocations` rows per row's `after_create` hooks (as usual).
- Field-level encryption applied per item (level 1/2 → `data_secret`).

### POST /app/doc/upsert  *(Batch 85.2)*

**Auth:** Editor on `app_tid`. Per-row ACL is **not** consulted on the
update branch — see "trade-off" below.

**Body:**
```json
{
  "app_tid":      "a_xxx",                              required
  "resource_tid": "r_xxx",                              one of *_tid|*_ma required
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
- **0 matches → CREATE.** Generates `d_<uuid>`, applies caller-supplied
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
  "data": { "tid": "d_xxx", "created": true|false, "resource_tid": "r_xxx" },
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
noaccess, deleted_at, created_at, updated_at}`. 404 → `NotFound`.

### POST /app/doc/create

**Auth:** Editor on `app_tid` (app-level Editor; the new doc inherits
app-level ACL since it has no per-doc ACL yet — author becomes the
caller).

**Body:**
```json
{
  "app_tid":      "a_xxx",                   required
  "resource_tid": "r_xxx",                   one of *_tid|*_ma required
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
  "data": { "tid": "d_...", "resource_tid": "r_..." },
  "timestamp": ... }
```

**Side effects:**
- `before_create` + `after_create` hooks fire (see hooks logic).
  `require_fields` hook failure → `hook_validation_failed`.
- Field-level encryption: keys declared `level >= 1` in resource
  schema persist in `data_secret` (AAD = `<doc_tid>|<field_name>`).
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

---

## Files (binary + static)

Files live in two stages — `release` (live) and `test` (staging).

### POST /app/file/upload

**Auth:** Editor on `app_tid` + email verified.

**Multipart fields:**
- `app_tid` — text, required.
- `stage` — text, optional (`release` default).
- `path` — text, optional; defaults to the uploaded file's name. Sent
  BEFORE the corresponding `file` part.
- `file` — binary, repeatable for batched upload.

**Limits:** 10 MB per file (`MAX_UPLOAD_BYTES`). Extension allowlist:
HTML/CSS/JS/JSON, common images, fonts, plain text. Banned ext →
`file_extension_not_allowed`. Oversize → `file_too_large`.

**Quota:** release-stage uploads charged against
`licenses.app_max_storage` AND `licenses.user_max_total_storage` for
the owner. Overshoot → `quota_app_max_storage`. Test-stage uses its
own per-app cap via `app_test_stages.used_storage`.

**Response data:** array of `{tid, path, stage, size, mime,
parent_tid, original}` per uploaded file.

**Side effects:** first write to a fresh test stage clones release in
first. `storage.delta` outbox row emitted on release writes (cause
`"upload"`).

### POST /app/file/save

**Auth:** Editor on `app_tid` (JSON-body alternative to multipart).

**Body:**
```json
{
  "app_tid":        "a_xxx",                 required
  "path":           "index.html",            required
  "content_base64": "...",                   required; standard or url-safe
  "mime":           "text/html",             optional override
  "stage":          "release" | "test"       optional, default release
}
```

Same caps + extension gate as `/upload`. Single file per call.

### POST /app/file/get

**Auth:** Reader on `app_tid` + per-row ACL.

**Body:** `{app_tid, path, stage?}`.

**Response data:** `{tid, path, stage, size, mime, content_base64}`.
Files > 10 MB return `{"msg":"file too large; use public asset URL",
"code":"file_too_large", "data":{path,size,mime,tid,max_bytes}}`.

### POST /app/file/list

**Auth:** Reader on `app_tid`. Body: `{app_tid, stage?}`. Returns
files + folders for the given stage; per-row ACL filters out rows the
caller can't see (owner/manager bypass).

### POST /app/file/del

**Auth:** Editor on `app_tid` + per-row `deletable` (owner/manager
bypass).

**Body:** `{app_tid, path, recursive?: false, stage?}`. Folder delete
needs `recursive: true` when non-empty (else
`{"code":"folder_not_empty"}`). Soft-delete — bytes move to
`_trash/<deleted_at>/<stage>/<path>`; quota still counts until
purge/sweep.

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

**Auth:** Manager on `app_tid` (irreversible). Body: `{app_tid,
file_tid}`. Removes DB row + trashed bytes + debits quota counters.

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

**Behaviour:** atomic promotion of test → release with backup of the
outgoing release. Per-app advisory PG lock prevents concurrent
promotion. Dry-run returns the diff without applying.

**Response (live):** `{promoted_rows, replaced_release_rows,
backup_at}`. **(Soft errors:** `No files in test stage`,
`Another release is already running...`.)

### POST /app/release/list

**Auth:** Manager on `app_tid`. Body: `{app_tid}`. Lists backup
snapshots (`{ts, has_manifest}`) sorted newest first.

### POST /app/release/rollback

**Auth:** Manager on `app_tid`. Body: `{app_tid, backup_ts}`. Walks
the manifest, captures a safety backup of the current release, then
restores. Same advisory-lock semantics.

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
role + strips its `[r_xxx]` token from every `apps.<acl_array>` and
`files.<acl_array>` row in the app.

---

## Audit (per-app feed)

### POST /app/audit/list  *(Batch 85.2)*

**Auth:** Manager on `app_tid`. Lets a tenant build an in-app audit
dashboard without sharing the global `/admin/audit/list` token.

**Body:**
```json
{
  "app_tid":         "a_xxx",            required
  "actor":           "u_xxx",            optional, filter by acting user
  "action":          "doc.upsert.update", optional, exact action match
  "action_prefix":   "doc.",             optional, LIKE 'prefix%'
  "target_kind":     "app",              optional, currently always 'app' — see scope note
  "target_tid":      "a_xxx",            optional
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
        "tid":             "au_xxx",
        "ts":              1735689600000,
        "actor_user_tid":  "u_xxx",
        "actor_username":  "alice",
        "action":          "app.acl_set",
        "target_kind":     "app",
        "target_tid":      "a_xxx",
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

**Auth:** Editor on `app_tid` + the doc's resource must have
`sharing = TRUE`.

**Body:**
```json
{
  "app_tid":    "a_xxx",     required
  "doc_tid":    "d_xxx",     required
  "target":     "u_xxx"      // OR "G_<grp>" | "[r_<role>]" |
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

**Response:** DNS instructions + verify_token, OR `auto_active: true`
when the domain is a sub of a domain you already own, OR
`delegation: {...}` when a parent owner granted you sub-binding.

### POST /app/domain/add

**Auth:** Owner on `app_tid`.

**Body:** `{app_tid, domain, verify_token?}` — `verify_token` from a
prior `/preview` call. Omitted only for local-dev hosts.

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

**Auth:** Parent owner. Body: `{app_tid, domain}`. Returns active
whitelist rows.

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

**Auth:** Parent owner. Body: `{app_tid, domain}`. Returns every
active sub bound under the parent (joined with app metadata).

### POST /app/domain/delegation/test-pattern

**Auth:** Parent owner. Dry-run helper for the label-rules editor.

**Body:** `{app_tid, domain, label, allow: [...], deny: [...]}`.

**Response data:** `{verdict: "allow"|"deny"|"no-allow-match",
matched_pattern, reason}`.

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
decrypted config JSON, or `null` (`not configured yet`), or
`operator not enabled for this app`.

### POST /app/integrations/config-set

**Auth:** Manager on `app_tid`. Body: `{app_tid, op_id, config}`.
Validates against the operator's schema. Encrypted at rest in
`operator_configs.config_encrypted`.

### POST /op/:op_id/:action

**Generic operator dispatcher.**

**Auth:** Resolved by the operator (most check `op_session`/`op_id`
context). The handler builds an `OperatorCtx` from the cookie if
present (user_tid optional — some pre-login operators like VNeID
`/auth` accept anonymous).

**Body:** must include `app_tid`. Any extra fields are forwarded as the
operator payload (`#[serde(flatten)]` on `extra`).

**Response (success):** `{result: true, data: <operator output>,
timestamp}`. Errors mapped per `OpError`:
- `NotEnabled` → `{"msg":"operator not enabled for this app"}`
- `NotConfigured(m)` → `{"msg":"operator not configured: <m>"}`
- `Invalid(m)` → 200 BadRequest envelope
- `Upstream{service,message}` → `{"msg":"<service> upstream error: <m>"}`
- `Internal(m)` → 500.

Every call writes an `op_invocations` audit row.

---

## WASM operators — tenant server-side code (shipped 2026-06-16)

The catalog above is platform-shipped (VietQR, VNeID, …). **WASM
operators** are the open lane for *your own* server-side logic: upload a
compiled `.wasm` module per app and it runs in a sandbox. The platform
owns the engine, ABI, and limits; the app owns the module. A module is
scoped to its `app_tid` and can never see another app's data.

### When to use it (vs. declarative hooks)

| Need | Use |
|---|---|
| "field X required / unique / format" | declarative validator (`require_fields`) |
| "copy/derive a field on write" | `set_fields` rule |
| "call an external HTTP service" | `webhook` (fire-and-forget), or a catalog operator |
| **custom server-side computation/validation over your own data** | **WASM operator** |

Embedded JS/Lua `eval` is intentionally NOT offered — WASM is the only
sandboxed code lane.

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
`host_mutate`) that run **as the invoking end-user**, through the *same*
ACL gates as `/app/doc/*`:
- App-scoped — a module only touches its own `app_tid`'s data.
- `host_query` applies the user's scope filter + per-doc read ACL.
- `host_mutate` create needs app-Editor + write-scope; update needs
  per-doc Editor + bidirectional scope (current **and** post-merge row).
- **A module can never exceed what the calling user may see or edit.**
- `public` operators get **no** host bridge (pure compute / webhook only).

### ABI (compiling a module)

Guest exports `memory`, `tfl5_alloc(i32)->i32`, `tfl5_invoke(i32,i32)->i64`;
the host provides `host_log` + `host_call` under module `"tfl5"`. Request
and response are JSON over linear memory. Any language that targets WASM
(Rust / TinyGo / AssemblyScript) works. Full byte-level spec: ask the
platform team for the internal `wasm-operator-abi.md`. SDK helpers:
`client.wasm.upload/activate`, `client.operator(opId).invoke(action, payload)`.

### Lifecycle endpoints (Manager on `app_tid`)

### POST /app/wasm/list

**Auth:** Manager. Body: `{app_tid}`. Returns uploaded versions with
`op_id, version, active, public, min_license, sha256, uploaded_at`.

### POST /app/wasm/upload

**Auth:** Manager. Multipart form: `app_tid, op_id, version, file` (the
`.wasm`, ≤10 MB) + optional `public`, `min_license`, `notes`. Validates
the module loads + exports the ABI surface **before** storing; stored
**inactive**. Tagged errors: `wasm_module_invalid`, `wasm_version_exists`.

### POST /app/wasm/activate

**Auth:** Manager. Body: `{app_tid, op_id, version}`. Atomically flips the
single active version per `(app_tid, op_id)` (advisory-locked). Re-checks
the license tier (`license_tier_required`).

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
  "app_tid":             "a_xxx",          // required
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
login-less service principal (`u-svc-…`) and grants it Editor access
to `target_resource_ma`; every push acts AS that principal through the
normal ACL gate. Revoking the source strips the grant. The caller
never supplies an identity — `principal_user_tid` is returned by the
server, not sent by the client.

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
the source, removes the auto-provisioned service principal's Editor
grant on the target resource, and invalidates the secret; subsequent
pushes with its `source_tid` return 404.

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
    "tid":          "d_xxx",
    "resource_tid": "r_xxx",
    "ingested":     1,
    "deduped":      0
  },
  "timestamp": 1700000000000
}
```

`ingested: 0, deduped: 1` when the push was a recognised duplicate.

**Error cases:**
- `X-Tfl5-Timestamp` missing or non-numeric → 200 `bad_request`.
- Timestamp outside replay window → 200 `bad_request`.
- Signature mismatch → 200 `access_denied`.
- Principal lacks Editor → 200 `access_denied`.
- Body not a JSON object → 200 `bad_request`.
- Source not found / revoked → 200 `not_found`.

---

## Email (per-app inbox + send)

### POST /app/email/send

**Auth:** Manager on `app_tid`. Mailler must be configured.

**Body:**
```json
{
  "app_tid":    "a_xxx",        required
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

Files attached to a doc, encrypted server-side; key derives from
`app_keys` via the doc DEK. ACL runs through `require_doc_perm`.

### POST /app/f3/upload

**Auth:** Editor on the doc (via `require_doc_perm`).

**Multipart fields:** `app_tid` (text), `doc_tid` (text), `level`
(text, `"1"|"2"|"3"`, default `1`), `name` (text), `file` (binary).

**Limits:** 100 MB per file. Levels: 1 = internal, 2 = confidential
(per-access audit), 3 = top-secret (per-grantee envelope).

### POST /app/f3/edit

**Auth:** Editor on the doc. Multipart with same fields. Replaces an
existing F3 file's bytes / metadata.

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
Soft-revoke (`revoked_at = now`).

### POST /app/f3/grants/list

**Auth:** Reader on the app. Body: `{f3_tid}`. Lists all grant rows
(`grantee_user_tid, granted_by, granted_at, revoked_at, revoked_by`).

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

### POST /platform/info

**Auth:** Anonymous (login page needs it pre-cookie).

**Response:**
```json
{ "test_subdomain_base": "...",
  "google_client_id":    "...",
  "telegram_bot_username":"...",
  "sso_authority_host":  "..." }
```

### GET /healthz

**Auth:** Anonymous (LB probe). `?include=version` adds `git_sha`
and `built_at`.

**Response (200):**
```json
{ "ok": true, "service": "tfl5", "cell_id": "default",
  "in_flight": 0, "cell_status": "live",
  "pg": { "primary_healthy": true, "replicas_total": 0,
          "replicas_healthy": 0 } }
```

**Response (503):** when draining OR primary down OR (all replicas
dead and replicas configured). Body includes `code:"service_draining"`
when draining.

---

## Error codes

Every error renders to the unified envelope (see error handling):
```json
{ "msg": "...", "code": "...", "timestamp": 1700000000000 }
```
plus `isSignout:true` for `Unauthorized`.

| `code`                          | HTTP | Where it comes from |
|---------------------------------|------|---------------------|
| `not_found`                     | 200  | `NotFound` variant + doc/share-not-found 200 paths |
| `unauthorized`                  | 401* | `Unauthorized` (* 200 if `TFL5_LEGACY_UNAUTHORIZED_200=1`) |
| `access_denied`                 | 200  | `AccessDenied` |
| `bad_request`                   | 200  | Generic `BadRequest(m)` |
| `internal`                      | 500  | `Internal(m)` |
| `auth_invalid_credentials`      | 200  | `/login` failure |
| `validation_invalid`            | 200  | `/reg` missing fields / turnstile fail |
| `validation_password_short`     | 200  | `/reg` password < 6 chars |
| `validation_username_taken`     | 200  | `/reg` duplicate username |
| `validation_email_taken`        | 200  | `/reg` duplicate email |
| `email_not_verified`            | 200  | `require_email_verified` on write paths |
| `quota_exceeded`                | 200  | `/app/update` create — app-count cap |
| `quota_app_max_storage`         | 200  | `/app/file/upload` `/save` — app or owner storage cap |
| `license_tier_required`         | 200  | `/app/integrations/enable` — tier too low |
| `resource_not_found`            | 200  | `/app/doc/list` `/create` — bad `resource_tid|ma` |
| `share_not_found`               | 200  | `/app/share/revoke` — already gone |
| `file_extension_not_allowed`    | 200  | upload/save — banned ext |
| `file_too_large`                | 200  | upload exceeds 10 MB; `/app/file/get` > 10 MB |
| `folder_not_empty`              | 200  | `/app/file/del` without `recursive: true` |
| `hook_validation_failed`        | 200  | declared `require_fields` hook rejected payload |
| `hook_invalid_shape`            | 200  | resource create/update bad `hooks[]` shape |
| `signed_url_expired`            | 410  | `GET /_signed/:token` past TTL |
| `signed_url_invalid`            | 403  | `GET /_signed/:token` bad HMAC |
| `twofa_not_enrolled`            | 200  | `/user/2fa/confirm` before `/enroll` |
| `tier_not_found`                | 200  | `/licenses/preview-upgrade` `/setup-tenant` bad tier |
| `bad_target`                    | 200  | `/licenses/preview-upgrade` non-app/non-user |
| `missing_app_tid`               | 200  | `/licenses/preview-upgrade` target=app w/o app_tid |
| `not_first_user`                | 200  | `/licenses/setup-tenant` non-first-user |
| `no_self_service_tier`          | 200  | `/licenses/setup-tenant` misconfigured deploy |
| `license_tier_not_self_service` | 200  | `/licenses/setup-tenant` above ceiling |
| `service_draining`              | 503  | `/healthz` while node is draining |

SDK consumers should match on `code` (stable across message
rewording).
