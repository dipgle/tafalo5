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
3. Uploading your static FE (HTML/JS) via the file API.
4. Binding a public domain.
5. Defining your data schema as *resources*.
6. Letting your FE call tfl5 APIs from the browser — `fetch` with
   the `_token` cookie tfl5 set on login.

You do **not** write Rust. You do **not** fork tfl5. You do **not**
define custom routes. All tenant logic is either:

- **Static FE code** (your HTML/JS, runs in the user's browser), or
- **Resource schema + declarative hooks** (validation + side-effects
  the platform executes for you), or
- **Operators** (officially supported integrations like email, ZNS,
  SMS, VietQR, VNeID — pre-built; you configure, you don't code), or
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
│  │    └─ tfl5 serves your static files from data/<cell>/  │ │
│  │       <your-app-tid>/public/                            │ │
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
license tier defaults to `demo` (1 app, 5MB content cap, 10MB total
quota). Upgrade via `/app/upgrade-license`.

### Step 3 — upload static FE

Two upload modes:

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
`_test/public/<path>` if `stage: "test"` is set.

Allowlist (release + upload): `html htm css js mjs map json png jpg
jpeg gif webp avif svg ico woff woff2 ttf otf txt xml`. Hard caps:
**10MB per file**, **license-tier dependent total quota**.

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
table. See [resource schema](#5-defining-resources-the-schema-shape).

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
resource itself has 7 ACL arrays inherited from the app's defaults
(see [acl-model.md](acl-model.md)). Patch them as you would the
app's: `/app/acl-set` works on the app row; resource-level
fine-grained edits live on the *doc* row, not the resource.

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
  what the caller may see/edit. Full reference: api-reference.md
  §Operators → "WASM operators". (Embedded JS/Lua `eval` is intentionally
  NOT offered — WASM is the one sandboxed code lane.)
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
- **Real-time WebSocket primitives** (chat, presence) — proxy layer
  exists but no first-party handler. Use external service for now.
- **Phone OTP delivery, ZNS push, SMS** — operators are scaffolded
  (zalo-zns, viettel-sms in Batch 84), but the actual HTTP send +
  template configuration is not yet wired through. Once tfl5 team
  finishes wiring + you obtain the relevant credentials,
  it's `/app/integrations/enable` + `/app/integrations/config-set`.
- **Tenant-defined endpoints** — you cannot register a new URL path.
  All tenant logic flows through:
  - `/app/doc/*` for data
  - `/app/file/*` for binary
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
