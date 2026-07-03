# tfl5 Recipes — practical patterns

> Cookbook for common tasks. Each recipe is self-contained — find the
> task in the TOC, copy-paste the request, adapt. Cross-references
> are to companion docs in this folder.
>
> **Companion docs:** [app-builder-guide.md](app-builder-guide.md) for
> concepts; [acl-model.md](acl-model.md) for authorization;
> [api-reference.md](api-reference.md) for endpoint shapes.

## Table of contents

1. [Find all docs a user has access to right now](#1-find-all-docs-a-user-has-access-to-right-now)
2. [Audit who touched a specific doc and when](#2-audit-who-touched-a-specific-doc-and-when)
3. [Bulk-move 200 students from grade 6A to grade 7A at end of school year](#3-bulk-move-200-students-from-grade-6a-to-grade-7a-at-end-of-school-year)
4. [Grant a user read access to all attendance docs for one student](#4-grant-a-user-read-access-to-all-attendance-docs-for-one-student)
5. [Generate a one-time shareable link to a single doc](#5-generate-a-one-time-shareable-link-to-a-single-doc)
6. [Encrypt a field the client never sees in plaintext at rest](#6-encrypt-a-field-the-client-never-sees-in-plaintext-at-rest)
7. [Validate input server-side without writing Rust](#7-validate-input-server-side-without-writing-rust)
8. [Push a notification when a record is created with a specific status](#8-push-a-notification-when-a-record-is-created-with-a-specific-status)
9. [Show only this teacher's class on a list-students page](#9-show-only-this-teachers-class-on-a-list-students-page)
10. [Soft-delete then permanently delete an app](#10-soft-delete-then-permanently-delete-an-app)
11. [Add an editor to a single doc without making them an editor of the whole app](#11-add-an-editor-to-a-single-doc-without-making-them-an-editor-of-the-whole-app)
12. [Test changes on the test stage before promoting to release](#12-test-changes-on-the-test-stage-before-promoting-to-release)

---

## 1. Find all docs a user has access to right now

**Task:** "Give me everything user `u_parent_bob` can read across all
resources in this app."

**Pattern:** no native "list everything user X can see" endpoint —
iterate per resource from that user's session. tfl5 returns only
rows the ACL gates pass.

```json
// Step 1 — list resources
POST /app/resource/list
{ "app_tid": "a-example" }

// Step 2 — list docs per resource (repeat for each)
POST /app/doc/list
{ "app_tid": "a-example", "resource_ma": "student",      "limit": 500 }
POST /app/doc/list
{ "app_tid": "a-example", "resource_ma": "attendance",   "limit": 500 }
POST /app/doc/list
{ "app_tid": "a-example", "resource_ma": "health_event", "limit": 500 }

// Step 3 — combine + dedupe by tid client-side
```

**Why this works:** ACL is row-scoped and evaluated on every call.
The platform doesn't materialise a per-user index of "which docs
are visible to whom" — that would scale O(users × docs). The cheap
path is: ask per resource; the gate runs naturally.

**Gotchas:**
- You must be that user's session to see what they see. Admin
  sessions see more (owner/manager bypass).
- `limit` caps at 500. Paginate with `offset` for larger sets.
- Soft-deleted rows excluded unless `include_deleted: true`.

**See also:** [api-reference.md POST /app/doc/list](api-reference.md#post-appdoclist),
[acl-model.md §5](acl-model.md#5-per-row-acl--docs--files).

---

## 2. Audit who touched a specific doc and when

**Task:** "List every actor who created, updated, or deleted doc
`d_xxx`, with timestamps."

**Pattern:** every mutation writes one `audit_log` row. Query via
the admin audit endpoint, filtered by target + action prefix:

```json
POST /admin/audit/list
{
  "action_prefix": "doc.",
  "target_tid":    "d_xxx",
  "limit":         100
}
// → data: [
//     { "action": "doc.create",  "actor_tid": "u_teacher_ann", "at_ms": ..., ... },
//     { "action": "doc.update",  ... },
//     { "action": "doc.acl_set", ... }
//   ]
```

**Why this works:** mutations (create/update/del/acl_set/role
membership/ownership transfer) all write to `audit_log`. Action
codes are stable string prefixes: `doc.*`, `role.*`, `app.*`.

**Gotchas:**
- `/admin/audit/list` is gated by Manager-of-`tfl5-admin`, not your
  app's managers. For tenant-readable audit, route the mutation
  through your own `webhook` hook and write into an audit resource
  you own.
- Hook firings live in `hook_invocations` (1 row per `after_*` run).
  Operator calls live in `op_invocations`. Query separately.

**See also:** [acl-model.md §11](acl-model.md#11-audit--traceability),
[app-builder-guide.md §5.2 hooks](app-builder-guide.md#52-hooks-jsonb-array--declarative).

---

## 3. Bulk-move 200 students from grade 6A to grade 7A at end of school year

**Task:** "Every student in `grade: 6A` becomes `grade: 7A`. 200 rows.
Don't make me hand-edit them."

**Pattern:** there is no batch-**update** endpoint today
(`/app/doc/create-batch` exists for creates only). List → loop →
update with rate-control:

```js
// Step 1 — list current 6A students
const list = await fetch('/app/doc/list', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    app_tid: 'a-example', resource_ma: 'student',
    where: { grade: '6A', school_id: 'sch_001' },
    limit: 500
  })
}).then(r => r.json());

// Step 2 — update each row, throttled
const CONCURRENCY = 4;
for (let i = 0; i < list.data.length; i += CONCURRENCY) {
  await Promise.all(list.data.slice(i, i + CONCURRENCY).map(doc =>
    fetch('/app/doc/update', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_tid: 'a-example', tid: doc.tid,
        data: { ...doc.data, grade: '7A' }
      })
    })
  ));
}
```

**Why this works:** `/app/doc/update` validates + applies one row
at a time, runs `before_update`/`after_update` hooks per row, and
writes one audit row each. Parallelism saves wall-clock; it doesn't
reduce work.

**Gotchas:**
- **No cross-row transaction.** If row #150 fails, rows 1–149 are
  already committed. Track failures + retry; the platform has no
  rollback API.
- `before_update` hooks run per row — a missing required field
  blocks only that one row, not the rest of the loop.
- `where` filter: max 10 keys, level-0 fields only.
- `/app/doc/update-batch` is a known gap — file a request to the
  tfl5 team if you need it.

**See also:** [api-reference.md POST /app/doc/update](api-reference.md#post-appdocupdate).

---

## 4. Grant a user read access to all attendance docs for one student

**Task:** "A grandparent (`u_grandparent`) needs read access to every
attendance + health event for student `s_001` — 200+ rows. Don't
edit each doc."

**Pattern:** don't touch the docs. Add the user to the per-student
parent role. Every doc with `[r_parent_of_s_001]` in `readers`
inherits the new member's access.

```json
// Find the role
POST /app/roles/list
{ "app_tid": "a-example" }
// → match by name "parent_of_s_001", get tid "r_parentof001"

// Edit members — pass the FULL new list, not a delta
POST /app/role/edit
{
  "app_tid": "a-example",
  "tid":     "r_parentof001",
  "members": ["u_parent_bob", "u_parent_carol", "u_grandparent"]
}
```

**Why this works:** role membership is the indirection that makes
ACL scale. Adding `u_grandparent` to the role instantly grants access
across all 200+ rows; removing them revokes. Zero doc updates.

**Gotchas:**
- `members` **replaces** — read first, write the full list.
- If your docs don't already carry `[r_parent_of_<student>]` in
  `readers`, this won't work — backfill via `/app/doc/acl-set` once.
- Role cache invalidates automatically on edit; in-flight requests
  past the gate complete with the prior permission set.

**See also:** [acl-model.md §6](acl-model.md#6-roles--the-indirection-that-makes-scaling-work),
[api-reference.md POST /app/role/edit](api-reference.md#post-approleedit).

---

## 5. Generate a one-time shareable link to a single doc

**Task:** "Give an external party a URL to read this one health_event row —
name + diagnosis code only, no national ID or address. Expires in 24 hours."

**Pattern:** anonymous share with field whitelist + expiry:

```json
POST /app/share/create
{
  "app_tid":    "a-example",
  "doc_tid":    "d_health_001",
  "target":     "anonymous",
  "fields":     ["full_name", "diagnosis_code", "payload.code"],
  "expires_at": 1717286400000,
  "resharable": false,
  "note":       "Share with external provider for triage"
}
// → { "tid": "sh_xxx", "token": "abc123def456..." }
```

Recipient opens `https://myapp.example.com/#/share?token=abc123...`;
your FE on that route calls:

```json
POST /app/share/claim
{ "app_tid": "a-example", "token": "abc123def456..." }
// → projected doc payload (only the whitelisted fields)
```

**Why this works:** sharing is an orthogonal channel — it does not
mutate the doc's own `readers` array. Revoke instantly via
`/app/share/revoke`. The field whitelist projects on read; the
recipient never sees fields outside the list.

**Gotchas:**
- Resource must have `sharing: TRUE` (set via `/app/resource/update`).
- `token` is returned **only** when `target == "anonymous"`. Targeted
  shares (user_tid or role token) don't get a link — the target
  reads via the normal `/app/doc/*` path.
- `fields: []` returns metadata only. Omit `fields` to share the
  full payload. Dot-paths work for nested keys (`payload.code`).
- For ongoing access by a known user, prefer per-doc ACL (recipe #11).

**See also:** [acl-model.md §8 Sharing](acl-model.md#8-acl-patching-endpoints),
[api-reference.md POST /app/share/create](api-reference.md#post-appsharecreate).

---

## 6. Encrypt a field the client never sees in plaintext at rest

**Task:** "Store the student's national ID encrypted at rest. Only
authorised callers get plaintext back."

**Pattern:** declare the field at `level: 1` or `level: 2` in the
resource schema. The platform encrypts on `/app/doc/create` and
decrypts on `/app/doc/get`/`list` for ACL-passing callers. The FE
just sends/receives plaintext.

```json
// Step 1 — declare encrypted fields in the resource
POST /app/resource/create
{
  "app_tid": "a-example", "ma": "student", "name": "Student",
  "fields": [
    { "field": "student_id",  "level": 0 },   // searchable
    { "field": "full_name",   "level": 0 },
    { "field": "grade",       "level": 0 },
    { "field": "national_id", "level": 2 },   // encrypted
    { "field": "address",     "level": 1 },
    { "field": "background",  "level": 1 }
  ]
}

// Step 2 — write plaintext; platform encrypts before INSERT
POST /app/doc/create
{
  "app_tid": "a-example", "resource_ma": "student",
  "data": {
    "student_id": "S-001",
    "full_name": "Alice Smith", "grade": "7A",
    "national_id": "ID-001234567890",
    "address": "123 Main St, Ward X",
    "background": "Low income household"
  },
  "readers": ["[r_parent_of_s_001]"]
}

// Step 3 — read back plaintext (gated by ACL)
POST /app/doc/get
{ "app_tid": "a-example", "tid": "d_xxx" }
```

**Why this works:** each app has a per-app KEK in `app_keys`,
wrapped by the cell's master key. Field-level encryption uses AEAD
with `AAD = <doc_tid>|<field_name>` so swapping ciphertexts between
fields/docs detects as tamper. Keys never leave the server.

**Gotchas:**
- **Encrypted fields aren't searchable.** `/app/doc/list { where: { national_id: ... } }`
  fails with `cannot_filter_encrypted_field`. If you need lookup
  by value, keep it `level: 0`.
- Don't reflexively mark everything `level: 2` — encrypted fields
  have a decrypt-on-read cost.
- `level: 3` (per-grantee sealed-box) is **not yet supported** at
  the resource level. For level-3 file attachments use `/app/f3/*`.

**See also:** [app-builder-guide.md §5.1 fields](app-builder-guide.md#51-fields-jsonb-array),
[api-reference.md POST /app/resource/create](api-reference.md#post-appresourcecreate).

---

## 7. Validate input server-side without writing Rust

**Task:** "Reject a `student` create if `student_id` is missing.
Don't trust the FE."

**Pattern:** declare a `require_fields` hook on the resource:

```json
POST /app/resource/update
{
  "app_tid": "a-example", "tid": "r_student",
  "hooks": [
    {
      "id":     "require_basic_fields",
      "on":     ["before_create", "before_update"],
      "type":   "require_fields",
      "params": { "fields": ["student_id", "full_name", "grade", "school_id"] },
      "msg":    "Missing required fields"
    }
  ]
}
```

Now any `/app/doc/create` or `/app/doc/update` missing those fields
fails with `{ "result": false, "code": "hook_validation_failed",
"msg": "Missing required fields" }`.

**Why this works:** hooks run inside the platform's request handler,
not in your FE. A malicious client can't bypass them via raw HTTP —
the gate is server-side. `hook_invocations` logs every firing.

**Gotchas — what `require_fields` CAN'T do today:**
- No regex (can't enforce specific ID format).
- No min/max for numbers or string length.
- No cross-field comparison (e.g. "if gender=female, require X").
- No referential integrity (can't check "school_id exists").

For any of those, validate in your FE (defence-in-depth: keep the
hook as a basic backstop) or route through an external service
that calls `/app/doc/create`.

Other hook types: `set_fields` (stamp `{user_tid}`, `{now_ms}` at
`after_create`), `webhook` (fire-and-forget POST). See
[app-builder-guide.md §5.2](app-builder-guide.md#52-hooks-jsonb-array--declarative).

**See also:** [app-builder-guide.md §5.2 hooks](app-builder-guide.md#52-hooks-jsonb-array--declarative),
[api-reference.md error codes](api-reference.md#error-codes).

---

## 8. Push a notification when a record is created with a specific status

**Task:** "When a teacher creates an attendance row with
`status = unexcused_absent`, send a notification to the parent."

**Pattern today:** declare an `after_create` webhook on the
`attendance` resource, gated by a `when` predicate. The webhook
hits your external notification service, which then calls the
relevant operator:

```json
{
  "id":   "notify_unexcused",
  "on":   ["after_create"],
  "type": "webhook",
  "params": {
    "url": "https://notify.example.com/parent-alert",
    "fields": {
      "doc_tid": "{doc_tid}", "by": "{user_tid}",
      "at":      "{now_ms}",  "app_tid": "{app_tid}"
    },
    "when": { "field": "status", "equals": "unexcused_absent" }
  }
}
```

Your notification service receives the POST, looks up the parent's
contact, then calls the operator to deliver:

```json
POST /op/zalo-zns/send
{
  "app_tid":      "a-example",
  "template_key": "attendance_alert",
  "phone":        "+<phone-number>",
  "params":       { "student_name": "Alice Smith", "date": "2026-06-01" }
}
```

**Why this works:** webhooks are async + filtered. The `when`
predicate keeps the fire-rate low. `/app/doc/create` returns
immediately; the webhook fires post-commit.

**What's wired vs. pending:**
- `webhook` hook type: **shipped + production-ready**.
- `zalo-zns` + `viettel-sms` operators: **scaffolded** — handlers
  exist but HTTP send is a stub. Production wiring + credential
  onboarding is **pending ops setup**. Verify before going live.
- Until ZNS is live, fall back to `/app/email/send` (mailler is
  production-ready) for the same alert.

**Roadmap (not shipped):** an inline operator-hook type that calls
`/op/<id>/<action>` directly from the hook phase, removing the
external-service bounce. Designed, not built.

**See also:** [api-reference.md POST /op/:op_id/:action](api-reference.md#post-opop_idaction),
[app-builder-guide.md §5.2 webhook](app-builder-guide.md#52-hooks-jsonb-array--declarative).

---

## 9. Show only this teacher's class on a list-students page

**Task:** "Teacher `u_teacher_ann` is homeroom of grade 7A at
`sch_001`. Her students page should show only her 7A students."

**Pattern:** `/app/doc/list` with `where` on level-0 fields:

```json
POST /app/doc/list
{
  "app_tid":     "a-example",
  "resource_ma": "student",
  "where":  { "grade": "7A", "school_id": "sch_001" },
  "limit":  500,
  "offset": 0
}
```

**Why this works:** `where` AND's its keys together; the platform
translates it to `data_indexed @> '<json>'::jsonb` backed by GIN.
Per-row ACL still applies on top — without `where`, the teacher would
still only see docs her tokens gate. `where` is for narrowing the UI
list, not for enforcing permission.

**Gotchas — `where` DSL constraints:**
- **Level-0 fields only.** Encrypted fields →
  `cannot_filter_encrypted_field`.
- **Max 10 keys.** More → `where_too_many_keys`.
- **Key format** must match `[a-z_][a-z0-9_]*`.
- **Equality + IN only.** `{"grade": ["6A", "7A"]}` works.
  No `gt`/`lt`/`like`/`between` today — reserved for v2.
- **No nested object values** → `cannot_filter_nested`.
- **500 rows per page** — paginate with `offset`.

**See also:** [api-reference.md POST /app/doc/list](api-reference.md#post-appdoclist),
[app-builder-guide.md §5.1 fields](app-builder-guide.md#51-fields-jsonb-array).

---

## 10. Soft-delete then permanently delete an app

**Task:** "Decommission an old pilot app. Soft-delete first
(reversible), then hard-delete after sign-off."

**Pattern:** `POST /app/del` is dual-mode. First call soft-deletes;
second call hard-deletes:

```json
// First call — soft delete (90-day window)
POST /app/del
{ "tid": "a_old_pilot" }
// → data: {
//     "tid": "a_old_pilot", "soft_deleted": true,
//     "deleted_at": 1717286400000,
//     "hard_delete_after": 1725062400000
//   }

// Second call — hard delete
POST /app/del
{ "tid": "a_old_pilot" }
// → data: { "tid": "a_old_pilot", "hard_deleted": true,
//           "files_removed": 1284, "errors": [] }
```

**Why this works:** soft-delete sets `apps.deleted_at = now()`,
hides the app from `/app/list`, stops serving its domains, but
preserves all rows. Hard-delete cascades to docs, resources, roles,
files, domains, share grants, operator configs.

**Preserved vs. removed (hard delete):**
- Removed: app row, resources, docs, roles, files (both stages),
  domain bindings, share grants, operator configs.
- Preserved: `audit_log`, `app_ownership_log`, `op_invocations` —
  compliance trail outlives the app.

**Gotchas:**
- Only Owner (`apps.author`) can call `/app/del`. Managers cannot.
- No minimum dwell time — back-to-back calls hard-delete immediately.
- `files_removed` is best-effort. Unreachable disk paths appear in
  `errors[]`; the DB row is still removed. Ops sweep cleans up orphans.

**See also:** [api-reference.md POST /app/del](api-reference.md#post-appdel),
[acl-model.md §11](acl-model.md#11-audit--traceability).

---

## 11. Add an editor to a single doc without making them an editor of the whole app

**Task:** "Teacher `u_teacher_ann` should be able to edit doc `d_xxx` only —
not every doc in the app."

**Pattern:** per-doc ACL via `/app/doc/acl-set`:

```json
POST /app/doc/acl-set
{
  "app_tid": "a-example", "tid": "d_xxx",
  "editors": ["u_teacher_ann", "[r_homeroom_7A]"]
}
// Omitted arrays preserve; pass [] to clear; non-empty overrides.
```

**Why this works:** per-row ACL **layers on top** of app-level. A
non-empty per-doc `editors` array decides who can edit *this row*,
independent of app-level Editor membership. App-level Reader is
still required to see the doc exists.

**Inheritance rules:**
- **Empty arrays = inherit.** All four empty → app-level decides.
- **Non-empty = override.** `editors: ["u_teacher_ann"]` means only her
  + doc author + app owner/manager can edit, even an app-level
  Editor not in the array is denied.
- **`noaccess` is a hard veto** at every level except `apps.author`
  (lockout protection).

**Gotchas:**
- Only doc author OR app Manager can call `/app/doc/acl-set`.
- ACL stored on the doc row — to apply to N docs, call N times
  (no batch ACL endpoint today).
- Prefer role tokens `[r_xxx]` over individual `user_tid`s when
  membership may change (same scaling logic as recipe #4).

**See also:** [acl-model.md §5](acl-model.md#5-per-row-acl--docs--files),
[acl-model.md §8](acl-model.md#8-acl-patching-endpoints),
[api-reference.md POST /app/doc/acl-set](api-reference.md#post-appdocacl-set).

---

## 12. Test changes on the test stage before promoting to release

**Task:** "I rewrote the onboarding HTML. Don't push to
production yet — let me browse it on a staging URL first."

**Pattern:** every app has two stages — `release` (live) and `test`
(staging). Upload to test, browse via the test subdomain, promote
atomically with `/app/release`.

```
# Step 1 — upload to test stage (multipart)
POST /app/file/upload
  app_tid = a-example
  stage   = test
  path    = /index.html
  file    = <bytes>
```

```json
// Step 2 — check stage state
POST /app/test/status
{ "app_tid": "a-example" }
// → data: { used_storage, cap, last_activity_at, idle_for_ms,
//           auto_delete_at, ttl_ms }
```

```
# Step 3 — browse the test stage in your browser:
# https://<app_tid>.<TFL5_TEST_SUBDOMAIN_BASE>/
# Check /platform/info for the actual base configured per cell.
```

```json
// Step 4 — atomic promote when happy
POST /app/release
{ "app_tid": "a-example", "dry_run": false }
// → data: { promoted_rows, replaced_release_rows, backup_at }
// (dry_run: true returns the diff without applying.)

// Rollback if the release looks wrong:
POST /app/release/list
{ "app_tid": "a-example" }
POST /app/release/rollback
{ "app_tid": "a-example", "backup_ts": 1717200000000 }
```

**Why this works:** the platform keeps two physical directories per
app — `data/<cell>/<app>/public/` (release) and `_test/public/`
(test). `/app/release` takes a per-app advisory PG lock and
atomically swaps them, snapshotting the outgoing release as a
timestamped backup.

**Quotas + lifecycle:**
- Test stage cap: **50 MB per app** (separate from release quota).
- Test stage TTL: **14 days idle** — sweeper auto-clears
  (`auto_delete_at`).
- File-extension allowlist + 10 MB per-file cap apply to both stages.
- Release stage consumes the app's licensed `app_max_storage`.

**Gotchas:**
- `/app/release` requires Manager on the app.
- One release at a time per app (advisory lock). Concurrent →
  `Another release is already running...`.
- Promote leaves the test stage populated so you can keep iterating.
  Use `/app/test/wipe` for a clean slate.
- Test subdomain works only when `TFL5_TEST_SUBDOMAIN_BASE` is
  configured at deploy time (`/platform/info` reports the base).

**See also:** [api-reference.md POST /app/release](api-reference.md#post-apprelease),
[app-builder-guide.md §4 step 3](app-builder-guide.md#step-3--upload-static-fe).
