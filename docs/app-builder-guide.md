# tfl5 App Builder Guide

> **Audience:** developers + AI agents building apps **on top of** tfl5.
> You consume the platform via fixed REST API; you do **not** modify Rust
> core. If you need a new endpoint, talk to the tfl5 team — adding routes
> per-tenant is explicitly out of scope (see [API Contract Discipline](#api-contract-discipline)).
>
> **Companion docs:** [acl-model.md](acl-model.md) for authorization;
> [api-reference.md](api-reference.md) for endpoint shapes.

---

## 1. What tfl5 gives you

tfl5 is a multi-tenant platform that runs a fleet of **apps**. An *app*
is a tenant: it has its own domain (e.g. `myapp.example.com`), its own
static files (HTML/JS/CSS), its own data tables (called *resources*),
its own users, and its own access-control rules. All of this lives in a
shared PostgreSQL + filesystem via tenant scoping.

You build an app by:

1. Registering a user account on tfl5 (one-time per dev).
2. Creating an app row (`POST /app/update` without `tid`).
3. Authoring your static FE (HTML/JS) — with the in-browser code
   editor, the visual no-code page builder, or a direct file upload.
4. Binding a public domain.
5. Defining your data schema as *resources*.
6. Letting your FE call tfl5 APIs from the browser — `fetch` with
   the `_token` cookie tfl5 set on login.

You do **not** write Rust. You do **not** fork tfl5. You do **not**
define custom routes. All tenant logic is either:

- **Static FE code** (your HTML/JS, runs in the user's browser) —
  written by hand and uploaded, dragged together in the visual
  no-code builder, or edited in-browser with the code editor; all
  three publish through the same versioned site engine (§4 step 3), or
- **Resource schema + declarative hooks** (validation + side-effects
  the platform executes for you), or
- **Operators** (officially supported integrations like email, ZNS,
  SMS, VietQR, VNeID, payment — pre-built; you configure credentials,
  you don't code), or
- **External services** you run elsewhere, calling tfl5 APIs from
  your server using a service token.

If your need doesn't fit any of those four, that's a tfl5-team
conversation — see [out of scope](#7-what-tfl5-does-not-give-you).

---

## 2. Mental model

```
┌─────────────────────────────────────────────────────────────┐
│  PUBLIC INTERNET                                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  https://<your-domain>/                                │ │
│  │    └─ tfl5 serves your static files — a published site │ │
│  │       snapshot if you have one, else data/<cell>/      │ │
│  │       <your-app-tid>/public/ (see §2.1)                 │ │
│  │                                                          │ │
│  │  https://<your-domain>/app/doc/list  (JSON API)        │ │
│  │  https://<your-domain>/app/file/upload                 │ │
│  │  https://<your-domain>/auth/email-link                 │ │
│  │  ...                                                    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  tfl5 CORE (you do NOT modify this)                         │
│   ┌────────────┐   ┌──────────┐   ┌──────────────────────┐ │
│   │ Routes     │ → │ Auth +   │ → │ Storage              │ │
│   │ + Routing  │   │ ACL gate │   │ - PG: apps, users,   │ │
│   │            │   │          │   │   resources, docs,   │ │
│   │            │   │          │   │   files, roles, …    │ │
│   └────────────┘   └──────────┘   │ - FS: data/<cell>/   │ │
│         │                          │   <app>/public/      │ │
│         ▼                          └──────────────────────┘ │
│   ┌──────────────┐                                          │
│   │ Operators    │ ← official integrations: email,         │
│   │ (catalog)    │   vietqr, vneid, zalo-zns, viettel-sms  │
│   └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
```

Your app **lives in `data/<cell>/<your-app-tid>/`** on the tfl5 server.
Static files in `public/`. Test-stage files in `_test/public/`.
Everything else (users, data rows, file metadata) is in shared PG
filtered by your `app_tid`.

### 2.1 Serving precedence — read this before you upload anything

A public request for `https://<your-domain>/<path>` is resolved through
**one precedence chain, first match wins**:

```
1. live snapshot   (site engine — /app/site/publish set a live version)
2. active bundle   (/app/bundle/activate set a versioned code deploy)
3. pinned release  (/app/release promoted a snapshot of public/)
4. legacy public/  (whatever's on disk right now — the mutable default)
```

Each tier is independent storage. **A file that exists in a lower tier
is silently SHADOWED by whichever higher tier is active** — this is the
single most common "why isn't my change showing up" question. Concretely:

- You `POST /app/file/upload` a new `index.html` straight into
  `public/` (tier 4), refresh your domain, and still see the old page.
  That's because the app was, at some point, published through the
  no-code builder or the code editor (`/app/site/publish`, tier 1) —
  the live snapshot answers every request until you either publish a
  new snapshot with your change or explicitly stop using the site
  engine for this app.
- Same story one level down: an activated bundle (tier 2, from
  `/app/bundle/activate`) shadows a pinned release or `public/` even
  though there's no site snapshot.

**The fix is always the same:** figure out which tier is actually
serving (ask "did this app ever go through the visual builder / code
editor?", or check with whoever owns the deploy pipeline), and make
your change in *that* tier — or explicitly roll it back
(`/app/site/rollback`, `/app/bundle/rollback`, `/app/release/rollback`)
to fall through to the tier you intended to edit. Uploading to a lower
tier is never wrong, it's just invisible until the tiers above it are
out of the way. See recipe [Why isn't my upload showing up?](recipes.md#13-why-isnt-my-uploaded-file-showing-up-serving-precedence).

---

## 3. Building blocks — when to use what

Four storage primitives. Pick by intent, not by guess.

| Primitive | What it stores | When to use |
|---|---|---|
| **apps** | The app row itself (metadata, ACL roots, license tier) | Created once per app. Edited via `/app/update`. |
| **resources** | A schema definition (1 per logical "table" in your app) | Created when you need a new kind of structured row. Like `CREATE TABLE` but the schema is JSONB. |
| **docs** | Structured data rows belonging to a resource | Every CRUD'd record (a student, an attendance row, a health event). |
| **files** | Binary blobs + paths (your static FE + user uploads) | HTML/JS/CSS for your app's UI. PDFs/images uploaded by users. Treat as filesystem. |

A typical app uses **all four**: app row for ownership, resources for
schema definitions, docs for data rows, files for both UI and binary
attachments.

Other primitives you'll meet less often:

| Primitive | What | When |
|---|---|---|
| **roles** | Per-app named groups (`r_homeroom_teacher`) | When you need to authorize by group instead of by individual user. |
| **shares** | Time-limited read-only handles to a single doc | When a user needs to send a one-off link to someone without granting full access. |
| **domains** | Custom hostnames bound to the app | Multiple domains per app supported; subdomain delegation built-in. |
| **operators** | Configured integrations (one per `op_id` per app) | Connecting to external services like email send, Zalo, VNeID. |
| **site** | Content-addressed draft + published-snapshot store for your app's site content (`/app/site/*`) | Publishing/updating your live site with full file history and one-click rollback — what the visual builder and the code editor both write through. |
| **f3 attachments** | Encrypted files bound to one doc's ACL and encryption key (`/app/f3/*`) | A per-record attachment (e.g. a signed PDF on a `health_event` row) that should inherit that row's readers/editors — distinct from `files`, which is app-wide, not doc-scoped. |

---

## 4. App lifecycle (the 6 steps)

### Step 1 — register a dev account

```
POST /reg
{ "username": "yourname", "password": "...", "re_password": "...", "email": "you@example.com" }
```

Sets a `_token` cookie. The **first** user to register on a fresh tfl5
install becomes Manager of `tfl5-admin` and can see the admin panel.

Alternative login paths (all set the same cookie):
- `POST /auth/email-link { email }` → `GET /auth/magic?token=...`
- `POST /auth/google { credential }` — Google Sign-In JWT
- `POST /auth/qr/start` → `/auth/qr/poll` — QR pair from another logged-in device
- `POST /auth/telegram/login { ... }` — Telegram Login Widget
- `POST /auth/phone/start|verify` — phone OTP *(operator delivery: in progress)*
- `POST /auth/vneid/start|callback` — VNeID OAuth *(requires merchant credentials)*

See [Authentication](api-reference.md#authentication).

### Step 2 — create an app

```
POST /app/update      (no tid → create mode)
{ "name": "School Manager", "description": "..." }
→ { result: true, data: { tid: "a-example" } }
```

You become the app's `author` (immutable owner) and Manager. Your
license tier defaults to `demo` (1 app, **52,428,800 B (50 MiB) per
app**, **52,428,800 B account total**). Both numbers were raised to
match the per-file upload cap exactly, on both the entitlement plan
and the legacy `licenses` fallback — before that a file at the
advertised size did not fit an empty free app. Upgrade via
`/app/upgrade-license`.

### Step 3 — author your static FE

Read [§2.1 Serving precedence](#21-serving-precedence--read-this-before-you-upload-anything)
first — it explains why the path you pick here matters.

**Recommended: the site engine (`/app/site/*`)** — a content-addressed
draft-then-publish store. This is what the in-browser code editor and
the visual no-code page builder both drive; you can use either UI, or
call the endpoints yourself:

```
POST /app/site/put              (JSON) — write one draft entry
{ "app_tid": "a-example", "path": "/index.html",
  "kind": "file",                       ← or "page" for a no-code component tree
  "content_text": "<html>...</html>" }  ← or content_base64 for binary

POST /app/site/publish           ← snapshot the current draft, flip it live
{ "app_tid": "a-example", "note": "launch copy" }
→ { result: true, live_snapshot: "<snapshot id>" }

POST /app/site/rollback          ← point Live back at an older snapshot
{ "app_tid": "a-example", "snapshot_id": "<older id>" }

POST /app/site/history           ← every past snapshot, for rollback/audit
POST /app/site/file-history      ← every past version of ONE file/path
```

Publish is atomic (a new immutable snapshot + a pointer flip, never a
partial write), and every file's history is addressable — a strictly
stronger guarantee than the legacy path below. `kind: "page"` entries
are JSON component trees rendered server-side by the no-code renderer
(headings, containers, text/image/button, and data-bound
table/list/**chart** nodes wired to your resources); `kind: "file"`
entries are served as-is (HTML you wrote yourself, CSS, JS, images).
Charts on a published page render with **Apache ECharts**, served by
the platform itself at `/_tfl5/vendor/*` — nothing to add to your page,
no CDN, no separate install.

**Legacy: direct file upload + release/test staging.** Still fully
supported, and simpler if you're shipping a small static site with no
need for draft/publish semantics:

```
POST /app/file/upload          (multipart/form-data)
- form fields: app_tid, path, file
```

or

```
POST /app/file/save            (JSON, base64)
{ "app_tid": "a-example", "path": "/index.html", "content_base64": "..." }
```

Both write to `data/<cell>/<app_tid>/public/<path>` (release stage) or
`_test/public/<path>` if `stage: "test"` is set. Optionally promote a
pinned, rollback-able snapshot of `public/` with `POST /app/release`
(see [recipes.md #12](recipes.md#12-test-changes-on-the-test-stage-before-promoting-to-release)).
Remember: this whole tier is **shadowed** the moment the app has a live
site snapshot (§2.1) — if you're seeing stale content after uploading
here, that's almost always why.

Allowlist (both paths): `html htm css js mjs map json png jpg jpeg gif
webp avif svg ico woff woff2 ttf otf txt xml md` (plus `csv xlsx docx`
and a small set of binary types for downloadable assets: `sqlite db bin
wasm zip tar gz`). Hard caps: **52,428,800 B (50 MiB) per file**
(`file/mod.rs:84` `MAX_UPLOAD_BYTES`), **license-tier dependent total
quota**.

### Step 4 — bind a domain

```
POST /app/domain/preview      ← preview returns DNS records you must set
{ "app_tid": "a-example", "domain": "myapp.example.com" }
→ {
    verify_token,
    records: [
      { type: "A",   host: "myapp.example.com",        value: "<server-ip>" },
      { type: "TXT", host: "_tfl5.myapp.example.com",  value: "..." }
    ]
  }

[user sets DNS records out-of-band]

POST /app/domain/add          ← verify + persist
{ "app_tid": "a-example", "domain": "myapp.example.com", "verify_token": "..." }
→ { result: true }
```

tfl5 verifies DNS A + TXT match, then activates. Caddy on-demand TLS
issues a Let's Encrypt cert next time `https://myapp.example.com` is hit.

For dev, `localhost:<port>` and `<tid>.test.<base>` (if
`TFL5_TEST_SUBDOMAIN_BASE` is configured) bypass the DNS check.

### Step 5 — define resources

A *resource* is your schema for a class of rows. Create one per logical
table. See [resource schema](#5-defining-resources--the-schema-shape).

```
POST /app/resource/create
{
  "app_tid": "a-example",
  "ma": "student",                   ← short code, [a-z0-9_-]+, unique per app
  "name": "Student",
  "description": "Student profile",
  "fields": [ ...field declarations... ],
  "hooks":  [ ...hook declarations... ]
}
→ { result: true, data: { tid: "r_xyz", ma: "student", name: "Student" } }
```

### Step 6 — ship

Your FE at `https://myapp.example.com/` calls tfl5 APIs:

```js
const r = await fetch('/app/doc/create', {
  method: 'POST',
  credentials: 'include',           // sends _token cookie automatically
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    app_tid: 'a-example',
    resource_ma: 'student',
    data: { student_id: 'S-001', full_name: 'Alice', grade: '7A' }
  })
}).then(r => r.json());
```

That's the whole lifecycle. Beyond this point you're iterating on FE
code, schema design, and ACL — none of which need tfl5 core changes.

---

## 5. Defining resources — the schema shape

A resource declaration has 3 fields you set, plus 4 ACL arrays you
can patch later via the apps-level ACL endpoints.

### 5.1 `fields` (JSONB array)

Each entry declares one field of the row:

```json
[
  { "field": "student_id",   "name": "Student ID",    "level": 0, "validator": "string" },
  { "field": "full_name",    "name": "Full Name",     "level": 0 },
  { "field": "grade",        "name": "Grade",         "level": 0 },
  { "field": "national_id",  "name": "National ID",   "level": 2 },
  { "field": "background",   "name": "Background",    "level": 1 }
]
```

The critical attribute is **`level`** — it decides where the value is
stored and whether the platform can index/query on it:

| `level` | Storage column | Indexable | Use for |
|---|---|---|---|
| `0` (default) | `data_indexed` (JSONB, GIN-indexed) | ✅ Yes — you can filter on it | IDs, lookup keys, non-PII categoricals (grade, school_id, date, status) |
| `1` | `data_secret` (AEAD-encrypted, per-field AAD) | ❌ Decryption-on-read only | Sensitive PII (address, family background, leave reason) |
| `2` | `data_secret` (same crypto as 1; semantic flag) | ❌ | Top-secret PII (national ID, medical diagnosis) |
| `3` | (rejected — 400) | — | Reserved for per-grantee sealed-box, not yet supported |

**Design rule:** if you'll ever query/filter by a field, mark it
`level: 0`. If it's truly PII you want hidden even from operators who
get a DB dump, mark `level: 1` or `2`. Don't reflexively mark
everything level-2 — encrypted fields aren't searchable, and your
FE will have to handle the slower deserialize path.

Two accepted shapes (array preferred for clarity):

```json
[ { "field": "x", "level": 0 } ]
```

or

```json
{ "x": "string", "y": { "type": "string", "level": 1 } }
```

Unknown fields in incoming `data` default to **level 0**. So a resource
with empty `fields: []` accepts any JSON — but nothing is encrypted.

### 5.2 `hooks` (JSONB array — declarative)

Hooks let you attach behavior to resource events **without writing
code**. The platform supports exactly 3 hook `type`s:

```json
[
  {
    "id": "validate_attendance_required_fields",
    "on": ["before_create", "before_update"],
    "type": "require_fields",
    "params": { "fields": ["student_id", "date", "status"] },
    "msg": "Missing required fields"
  },
  {
    "id": "stamp_created_by_and_at",
    "on": ["after_create"],
    "type": "set_fields",
    "params": {
      "set": {
        "created_by_user_tid": "{user_tid}",
        "created_at_ms": "{now_ms}"
      }
    }
  },
  {
    "id": "notify_parent_on_unexcused_absence",
    "on": ["after_create"],
    "type": "webhook",
    "params": {
      "url": "https://notify.example.com/parent-alert",
      "fields": {
        "doc_tid": "{doc_tid}",
        "student_id": "{doc_tid}",
        "by": "{user_tid}",
        "at": "{now_ms}"
      },
      "when": { "field": "status", "equals": "unexcused_absent" }
    }
  }
]
```

| `type` | Phase | Behavior |
|---|---|---|
| `require_fields` | `before_*` only | If any listed field is missing/empty, reject with `hook_validation_failed`. Other phases silently ignored. |
| `set_fields` | `after_*` only | Patches `data_indexed` via `jsonb_set`. Failures logged, doc write already committed. |
| `webhook` | `after_*` only | Async HTTP POST to `params.url`. Optional `when` predicate to filter. Audit row written either way. |

**Required entry fields:** `id` (non-empty), `on` (non-empty array of
strings), `type` (one of the three). Anything else → 400
`hook_invalid_shape` at resource create/update.

**Token substitution** in `set_fields.params.set` and `webhook.params.fields`:
`{user_tid}`, `{now_ms}`, `{doc_tid}`, `{resource_tid}`, `{app_tid}`.
Unknown tokens are left literal — no error, deliberately, so
forward-compatible hook authors aren't blocked.

**What hooks CANNOT do** (deliberate scope):
- Run arbitrary code *in a declarative hook* (no JS eval, no Lua). For
  server-side custom logic, add a **`wasm` hook** or a **WASM operator**
  instead (see api-reference.md §Operators → "WASM operators"). Declarative
  hooks deliberately stay code-free.
- Block on external HTTP — `webhook` is fire-and-forget
- Sync over to another resource — use the webhook to call a service that calls `/app/doc/create` back
- Read other docs as part of validation — `require_fields` is local

If you need something hooks can't express today, your FE code or your
external service does it.

### 5.3 ACL arrays on a resource

When you create a resource you implicitly become its author. The
`resources` row carries **7 ACL arrays** of its own — `managers`,
`designers`, `authors`, `editors`, `readers`, `deletable`, `noaccess`
(see [acl-model.md](acl-model.md)).

Three levels, three different rows, three different endpoints. Mixing
them up is the most common way to "set the ACL" and change nothing:

| Level | Row | Written by |
|---|---|---|
| **L1 — app** | `apps` | `/app/acl-set` (replaces the buckets you supply, preserves the ones you omit) or `/app/acl/{set,revoke,bulk-import}` for incremental edits |
| **L2 — resource type** | `resources` | `/app/resource/create` and `/app/resource/update` — **there is no `/app/resource/acl-set`** |
| **L3 — one document** | `docs` | `/app/doc/acl-set` |

⚠ Two traps on L2. The create/update bodies accept only **four** of the
seven arrays — `readers`, `editors`, `noaccess`, `deletable`; the other
three are returned by `/app/resource/get` but those request bodies do
not take them. And `/app/resource/get` returns every ACL array as `[]`
to a caller without control-plane visibility, so an empty array there
means "you cannot see it", not "nobody is listed".

In the SDK, L2 is `tfl5.resource(ma).setResourceAcl({...})`, which posts
`/app/resource/update` underneath.

---

## 6. The 4 things every FE call does

Whether you're saving a student, marking attendance, or fetching a
KPI snapshot, your FE follows the same shape:

```
1. fetch('/app/<endpoint>', {
     method: 'POST',
     credentials: 'include',      ← sends `_token` cookie
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ app_tid, ...payload }),
   })
2. response = { result, data?, msg?, code?, timestamp }
3. if (!response.result) handle error code
4. else use response.data
```

**Always include `app_tid` in the body** — tfl5 routes resolve which
app context they're acting on from the body, not from the hostname or
the URL path. Even when called from your domain.

**Error contract:** `{ result: false, code: "<short_code>", msg: "..." }`
with HTTP 200 (legacy tfl5 wire convention). Auth failures return
`code: "unauthorized"`. Permission failures return `code: "forbidden"`.
See [error codes](api-reference.md#error-codes).

**Pagination:** when an endpoint supports `limit`, it caps at 500
(`/app/doc/list` default 100, max 500). Cursor pagination is endpoint-
specific — most use `offset` or order by `created_at DESC` + filter.

---

## 7. What tfl5 does NOT give you

Be honest with yourself about these before you design:

- **Server-side custom code execution** (WASM operators) — **SHIPPED**
  (2026-06-16, deployed). Upload a compiled `.wasm` module per app; it
  runs in a fuel/memory/time-bounded sandbox, either as a doc-lifecycle
  hook (`"type":"wasm"`) or an HTTP `/op/<id>/<action>` endpoint. Data
  access runs **as the calling user's ACL** — a module can never exceed
  what the caller may see/edit, and a denied read comes back as an EMPTY
  ARRAY rather than an error, so "empty" never proves "no such rows".
  Full reference: wasm-operator-abi.md (the guest↔host contract).
- **Per-resource JavaScript hooks** (QuickJS) — **SHIPPED**, and a second
  sandboxed code lane alongside WASM. Code lives in the resource's own
  `before_create_code` / `after_create_code` / `before_update_code` /
  `after_update_code` columns and runs bounded to **100 ms** wall time and
  a **16 MiB** heap (`crates/operators/src/js_hooks/mod.rs`,
  `MAX_WALL_MS` / `MAX_HEAP_BYTES`). A *before* hook may rewrite the
  payload or reject the write — the refusal arrives as the static
  `code: "hook_reject"` with your own tag folded into `msg` as
  `[<tag>] …`, so branch on the code and display the tag. An *after* hook
  is fire-and-forget: its errors are logged and never fail the response,
  and its mutations are deliberately not persisted. ⚠ Only those four
  events are wired — a before-hook on any other event (e.g. `before_del`)
  is silently inert.
- **Marketplace / app catalog** — designed in vision, not built.
  Single-tenant deploys for now.
- **Aggregate / GROUP BY queries** — `/app/doc/list` returns rows.
  No `SUM`, `COUNT BY`, `GROUP BY` at the API level. Workaround:
  pre-compute snapshots via your own nightly cron + store in a
  `<...>_snapshot` resource.
- **Filtering on `data_indexed` content from the API** — `/app/doc/list`
  supports a `where` DSL for level-0 fields (Batch 85). You can ask
  "list docs where `data.grade = 7A`". Encrypted fields are not
  filterable; client-side narrowing or a hook-maintained mirror is the
  workaround for those.
- **Batch update** — current API is one row per call. 30 attendance
  records = 30 calls. tfl5 team is aware; `/app/doc/update-batch`
  is on the list but not built yet.
- **Cross-resource transactions** — create student + create
  student_parent_link must be 2 sequential calls. Compensate in your
  FE on partial failure.
- **Cron jobs you can configure from inside tfl5** — no per-app
  scheduler. Run cron in your own infra; call tfl5 APIs from there
  with a service token.
- **Real-time WebSocket chat** — **SHIPPED.** `GET /ws/chat` is a
  first-party, Reader-gated WebSocket per app (room-scoped, messages
  persisted, scrollback via `POST /app/chat/history`, row-level scope
  supported). Not something you need an external service for anymore.
  A generic pub/sub *other than chat* (arbitrary presence/broadcast
  channels) still isn't a first-party primitive — build that on top of
  `/app/doc/*` + your own polling/webhook, or ask the tfl5 team.
- **Durable, stateful server-side compute** — exists (a WASM-based
  durable-execution primitive: exactly-once message delivery,
  crash-safe replay, reactive projections streamed over
  `/ws/durable/subscribe`) but ships **default-OFF**. The operator
  running your tfl5 instance has to explicitly enable it
  (`TFL5_DURABLE_ENABLED`); until they do, every `/durable/*` endpoint
  behaves as if the feature doesn't exist. Confirm it's turned on
  before designing around it — most apps don't need this and should
  reach for a plain `resource` + hooks instead.
- **Phone OTP delivery, ZNS push, SMS** — the dispatch is wired for
  real: `/auth/phone/*` and the `zalo-zns` / `viettel-sms` operators
  make an actual HTTP call to Zalo/Viettel on `send`, not a stub. What's
  still on you is the credentials: Zalo needs an Official Account id +
  access token, Viettel needs a CP code + registered brand name +
  service key, both set via `/app/integrations/enable` +
  `/app/integrations/config-set`. **Config-ready, not config-free** —
  same pattern as payment below: an unconfigured operator fails the
  send (logged, not silent) rather than working out of the box.
- **Payment checkout** — `GET /billing/catalog` is public and live (one
  price per plan, no feature matrix, no sign-in required) and doubles as
  your pricing-page data source. Actually charging a card runs through
  a provider (`POST /billing/webhook/:provider` settles it), and a
  provider only exists once its webhook secret is configured in the
  server's environment — an unconfigured/unknown provider name is
  indistinguishable from a 404. Confirm with whoever runs your instance
  which provider(s) are actually live before building a checkout flow
  around one.
- **Tenant-defined endpoints** — you cannot register a new URL path.
  All tenant logic flows through:
  - `/app/doc/*` for data
  - `/app/site/*` for your published site content (§4 step 3)
  - `/app/file/*` for app-wide binary storage, `/app/f3/*` for
    per-doc encrypted attachments
  - `/op/<op_id>/<action>` for integrations
  - your own external service for things outside the above

### API Contract Discipline

The tfl5 API is a **fixed contract**. Adding endpoints is a tfl5-core
change, not a tenant config. Your app does **not** define new routes.
This is intentional — fixed surface = single auth model, single audit
trail, single docs source. Ask the tfl5 team if you need a new
endpoint; don't simulate one with workarounds.

If you find yourself wanting a new endpoint, the questions to ask
in order are:

1. Can I do this with `/app/doc/*` + a resource schema?
2. Can I do this with a declarative hook?
3. Can I do this with an existing operator?
4. Can I do this in client-side JS in my FE?
5. Can I do this in an external service that calls tfl5?

If all five are no, file a request to tfl5 team. Don't simulate via
ad-hoc workarounds — they will rot when the platform shifts.

---

## 8. End-to-end walkthrough — student record flow

Concrete example covering create app → resources → hooks → ACL →
doc CRUD.

**Goal:** A teacher (`u_teacher_ann`) creates a student record; the
student's parent (`u_parent_bob`) can read it; other parents and other
teachers cannot.

```text
# Step 1 — u_teacher_ann is logged in (cookie set from /login)

# Step 2 — Create the role that will gate per-student parent access
POST /app/role/create
{
  "app_tid": "a-example",
  "name": "parent_of_student_001",
  "description": "Parents of student 001",
  "members": ["u_parent_bob"]
}
→ { result: true, data: { tid: "r_parentof001", ... } }

# Step 3 — Define the student resource
POST /app/resource/create
{
  "app_tid": "a-example",
  "ma": "student",
  "name": "Student",
  "fields": [
    { "field": "student_id",   "level": 0 },
    { "field": "full_name",    "level": 0 },
    { "field": "grade",        "level": 0 },
    { "field": "school_id",    "level": 0 },
    { "field": "ward_id",      "level": 0 },
    { "field": "national_id",  "level": 2 },
    { "field": "background",   "level": 1 }
  ],
  "hooks": [
    {
      "id": "validate_required",
      "on": ["before_create", "before_update"],
      "type": "require_fields",
      "params": { "fields": ["student_id", "full_name", "grade"] }
    },
    {
      "id": "stamp_creator",
      "on": ["after_create"],
      "type": "set_fields",
      "params": {
        "set": {
          "created_by_user_tid": "{user_tid}",
          "created_at_ms": "{now_ms}"
        }
      }
    }
  ]
}
→ { result: true, data: { tid: "r_student", ma: "student", ... } }

# Step 4 — Create the student doc, pin per-row ACL so only this
# student's parent (via role token) can read
POST /app/doc/create
{
  "app_tid": "a-example",
  "resource_ma": "student",
  "data": {
    "student_id": "S-001",
    "full_name": "Alice Smith",
    "grade": "7A",
    "school_id": "sch_001",
    "ward_id": "ward_001",
    "national_id": "ID-001234567890",
    "background": "Low income household"
  },
  "readers": ["[r_parentof001]"],        ← role token = parents of THIS student
  "editors": ["u_teacher_ann"],          ← teacher who created stays editor
  "deletable": ["u_teacher_ann"]         ← teacher can delete
}
→ { result: true, data: { tid: "d_xxx", ... } }

# Step 5 — From u_parent_bob's session, list students they can see
POST /app/doc/list
{
  "app_tid": "a-example",
  "resource_ma": "student"
}
→ { result: true, data: [ {tid:"d_xxx", data:{student_id:"S-001", full_name:"Alice Smith", grade:"7A", national_id:"ID-001234567890", background:"Low income household"}, ...} ] }
# u_parent_bob sees the row because they're in r_parentof001, which is in
# the doc's readers. They see the encrypted PII (national_id, background) too
# because the app key is per-app — readers automatically decrypt.

# Step 6 — From a different parent's session, same call returns []
# because their user_tid isn't in any role/group/array on this doc
```

**Notes:**
- The role-token pattern `[r_parent_of_<student_id>]` is a convention
  you enforce in your app; tfl5 doesn't mandate it. The convention
  scales to thousands of students because each role row is small + the
  `apps`-level token resolution is GIN-indexed.
- Other records for the same student (attendance, health events) can carry
  the same `[r_parentof001]` token in `readers`. Parent sees all of them
  via ONE role membership entry, not N grants.
- When the student moves schools, update the role's `members`
  array (`/app/role/edit`) — not every doc's ACL. That's the whole
  point of role indirection.

---

## 9. Where to learn more

| You need to know about | Read |
|---|---|
| Authorization, role/group tokens, lock-out rules, conventions | [acl-model.md](acl-model.md) |
| Every endpoint's exact request/response shape | [api-reference.md](api-reference.md) |
| Practical copy-pasteable patterns | [recipes.md](recipes.md) |

Internal tfl5 platform docs (architecture, deployment, decision
rationale) are not in this folder — ask the tfl5 team if a "why was
it designed this way?" question blocks you.

If you're an AI agent picking up this folder to build an app, the
short reading order is: **this guide → acl-model.md → api-reference.md**.
