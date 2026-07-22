# tfl5 Authorization Model

> Companion to [app-builder-guide.md](app-builder-guide.md). This is the
> SINGLE source of truth for how authorization works on tfl5. Every
> endpoint enforces the rules here.
>
> If you're tempted to add a new column for permission, **stop and read
> this doc** — the existing 6-array model handles every case the
> platform supports today.

---

## 1. TL;DR

**Authorization on tfl5 is FOUR layers that AND together.** Every doc
read/write must pass ALL applicable layers — any single layer can deny:

```
L1  App-level ACL       — 5 levels on the `apps` row (§2–§4)
        ↓  AND
L2  Resource-type ACL   — arrays on the `resources` row (§6)
        ↓  AND
L3  Per-row / per-doc ACL — arrays on the doc/file row (§5)
        ↓  AND
L4  Row-level scope      — field-based fencing (§7, opt-in)
```

A caller sees/edits a doc only if L1 **and** L2 **and** L3 **and** L4 all
say yes. Emptiness is permissive: an empty L2/L3 array inherits the layer
above; L4 is off unless the app opts in. `noaccess` and the scope filter
never *grant* — they only subtract.

- 5 permission levels: `Owner > Manager > Designer > Editor > Reader`
- Each row that has ACL has 4-7 arrays of **tokens**: `managers`,
  `designers`, `editors`, `readers`, `deletable`, `noaccess`
  (and `authors` on resources)
- A **token** can be a `user_tid`, a role token `[r_<role-tid>]`, or a
  group token `G_<group>`
- `noaccess` is a hard veto. Author + Manager can override almost
  anything (lockout protection).
- Per-doc and per-file ACL stack ON TOP of app-level ACL. Empty
  per-row ACL = inherit app-level.
- The resource-type ACL (L2) and row-level scope (L4) are the two layers
  that let you fence *categories* of data and *individual rows by field*
  without exploding role tokens.

---

## 2. The 5 permission levels

```
Owner   ───  only apps.author can act
Manager ───  apps.author OR in apps.managers
Designer ──  apps.author OR managers OR designers
Editor  ───  apps.author OR managers OR designers OR editors
Reader  ───  apps.author OR managers OR designers OR editors OR readers
```

The hierarchy is strictly **inclusive upward**: a Manager satisfies
every endpoint that requires Reader or Editor or Designer.

**Email verification gate:** every level except Reader additionally
requires `users.email_verified = true`. Reader is exempt so unverified
users can still browse + click "Verify email". Write endpoints fail
with `code: "email_not_verified"`.

### Mapping levels to endpoints (typical)

| Operation | Required level |
|---|---|
| Read app list / get app / read resources, docs, files | Reader |
| Create / update doc, upload file, create role | Editor (or per-row override) |
| Define resource, manage user list, ACL patch | Manager |
| Delete app, bind domain, transfer ownership, master-key rotate | Owner |

The Designer level exists in the schema but is used by very few
endpoints today (mostly file upload metadata). When in doubt assume
Manager.

---

## 3. Tokens — the things you put in ACL arrays

A "token" is a string entry in one of the 7 ACL arrays. Three valid forms:

| Form | Example | Meaning |
|---|---|---|
| **user_tid** | `u_abc123` | Specific user. Granted token bypasses noaccess only if also app author. |
| **role token** | `[r_homeroom_teacher]` | Any user whose `users.tid` is in the role's `members` array. **Brackets are part of the token literal.** |
| **group token** | `G_author` | A sentinel group. `G_author` = "any authenticated user." Custom groups TBD (not commonly used for tenant apps). |

**Critical convention:** ACL arrays hold `user_tid` (not username),
written as plain strings. The bootstrap user-promotion path (`/reg` →
first user becomes `tfl5-admin` Manager) inserts `user_tid`. Follow
the same convention in your app's `/app/acl-set` calls.

**Role token has brackets.** `[r_xxx]` is not a string substitution
placeholder — those brackets are literally part of the value stored in
the array. The token format mirrors the JS port's permission set
shape; trying to use a bare `r_xxx` token won't match.

### When a user makes a request, their effective permission set is:

```
perms = [
  for each role they're in:    "[<role-tid>]",
  for each group they're in:   "<group-tid>",
  their username,
  their user_tid,
]
```

The check `any_match(acl_array, perms)` returns true if any element
appears in both. That's it — no complex graph traversal, no implicit
inheritance.

---

## 4. The decision algorithm (app-level)

For `require_app_perm(app_tid, level)`:

```
1. Resolve the caller's session from _token cookie.
2. SELECT author, managers, designers, editors, readers,
        deletable, noaccess FROM apps WHERE tid = $app_tid
3. If the row doesn't exist → AccessDenied
4. If caller.user_tid == row.author → PASS (owner bypass)
5. If level == Owner → DENY (only author passes Owner)
6. If any token in row.noaccess matches caller.perms → DENY
7. Test against the level's allowed arrays:
   - Manager: managers
   - Designer: managers OR designers
   - Editor:   managers OR designers OR editors
   - Reader:   managers OR designers OR editors OR readers
   If any match → PASS
8. If level != Reader: also require email_verified = true
```

**Owner bypass.** The author always passes — including the `noaccess`
check. This is the lockout protection: even if a malicious co-manager
adds the author to `noaccess`, the author can still administer the app.

**noaccess wins over everything except author.** Even a Manager in
both `managers` AND `noaccess` is denied (`noaccess` evaluated first).

---

## 5. Per-row ACL — docs + files

Some rows (docs, files) carry their own ACL arrays. These layer on
top of app-level:

**For docs (`docs` table):** `editors`, `readers`, `deletable`,
`noaccess` + `author` (column).

**For files (`files` table):** `managers`, `editors`, `readers`,
`deletable`, `noaccess` + `author`.

### Decision order for per-doc / per-file:

```
1. Caller must pass app-level Reader check (gates probing).
2. If row.noaccess matches caller.perms → DENY (hard veto).
3. If caller == row.author OR caller is app owner/manager → PASS.
4. If row has ANY non-empty explicit ACL array:
   - Reader: row.editors OR row.readers OR row.deletable
   - Editor: row.editors
   - (Manager/Designer not meaningful at row level — fall through to
     app-level if requested)
5. If row has NO explicit ACL → inherit app-level decision.
6. If level != Reader: also require email_verified.
```

**Key insight:** **empty per-row ACL means inherit**, not "deny." A doc
with all four arrays empty is visible to anyone with app-level Reader.

**Per-row ACL can GRANT additional access.** A doc with `editors:
[u_bob]` makes Bob an editor even if Bob is only an app-level Reader.
This is the row-scoping mechanism for fine-grained delegation.

**Per-row ACL can RESTRICT via noaccess.** A doc with `noaccess:
[u_carol]` hides the doc from Carol even if Carol is app-level Reader.

---

## 6. Resource-level ACL — gating a KIND of data (L2)

The per-row ACL in §5 answers *"who can touch THIS record."* The
resource-level ACL answers the coarser question *"who can touch THIS
KIND of record at all"* — it gates every doc op on a resource **type**
before the request ever reaches an individual row.

The `resources` table carries the same ACL-array shape as `apps` and
docs:

```
resources.author
resources.editors      ← enforced by the doc gate
resources.readers      ← enforced by the doc gate
resources.deletable    ← enforced by the doc gate
resources.noaccess     ← enforced by the doc gate (hard veto)
resources.managers     ← stored + returned, NOT used by the doc gate*
resources.designers    ← stored + returned, NOT used by the doc gate*
resources.authors      ← stored + returned, NOT used by the doc gate*
```

\* **Accuracy note.** The doc-op gate
(`crate::auth::resource_acl_allows`) reads and enforces only
`author`, `editors`, `readers`, `deletable`, `noaccess`. The
`managers` / `designers` / `authors` arrays are persisted on the row
and echoed back by `/app/resource/get`, but at Manager/Designer level
the gate returns deny — so they do not currently grant doc access on
their own. Rely on `editors` / `readers` / `deletable` (plus the
owner/manager bypass below) to fence a resource. Don't design around
`resources.managers` as a doc gate; it isn't wired as one today.

### How it's enforced

On every doc op the handler calls, in order:

```
require_app_perm(app, Reader|Editor)     ← L1
  → resource_acl_allows(app, resource, level)  ← L2
    → scope_filter::resolve(...)               ← L4
```

The L2 call sits between the app-level check and the row scope filter.
It is wired on all five doc paths:

| Doc op | L2 level asked |
|---|---|
| `/app/doc/list` | Reader |
| `/app/doc/get` | Reader |
| `/app/doc/create` | Editor |
| `/app/doc/update` | Editor |
| `/app/doc/del` | Editor (+ `deletable`) |

Decision inside `resource_acl_allows`:

```
1. `_cluster` synthetic user → PASS (cross-tenant orchestration bypass).
2. If caller == resource.author OR caller is app owner/manager → PASS.
3. If resource.noaccess matches caller.perms → DENY.
4. If resource has NO explicit editors/readers/deletable → PASS
   (empty = permissive; inherit the app-level + per-row decision).
5. Else AND-gate the caller into the level's array:
   - Reader: editors OR readers OR deletable
   - Editor: editors
```

**Empty = inherit, not deny** — same rule as per-row (§5). A resource
with all positive arrays empty is fully governed by L1 + L3 + L4. This
is the pre-REQ-TFL5-015 backward-compatible default: existing resources
keep behaving exactly as before until you opt in by populating an array.

**Deny is quiet on read.** When L2 denies a `list`/`get`, the endpoint
returns the same empty-success envelope as a zero-row page — no
existence leak. On write it returns `AccessDenied`.

### Setting + reading the resource ACL

- **Read:** `POST /app/resource/get { app_tid, tid }` returns the arrays
  in `data.{editors,readers,deletable,noaccess,managers,designers,authors,author}`.
  The ACL arrays are only populated in the response for an
  owner/manager caller (control-plane gate); a mere Reader sees `[]`.
- **Set:** the arrays are written through `/app/resource/create` and
  `/app/resource/update` (fields `readers`, `editors`, `noaccess`,
  `deletable`; omitted = preserve via COALESCE, `[]` = clear). Both
  endpoints are Manager-gated. Role tids are bracket-wrapped
  (`[r-…]`) on the way in. There is **no** separate
  `/app/resource/acl-set` endpoint — use create/update.

### Resource-ACL vs per-row ACL — when to use which

| | Resource-level (L2) | Per-row (L3) |
|---|---|---|
| Scope | a whole resource **type** | one doc/file **record** |
| Question | "who can touch this KIND of data" | "who can touch THIS record" |
| Typical use | lock a `salary` resource to HR; open a `notice` resource to all | grant Bob edit on one specific doc |
| Storage | `resources` row | `docs` / `files` row |

Use L2 to draw the broad boundary (only HR reads any `salary` doc),
then L3 to carve exceptions within what L2 already allows. They AND
together — L2 can only *narrow*, never widen, what L3 also permits.

---

## 7. Row-level scope — field fencing (L4)

Scope is the fourth and innermost layer. Instead of putting a role
token on **every row** (the §11 approach), you declare — once, in the
app config — *which column* carries the tenancy value and *which values*
each user is allowed to see. The server then AND-s the predicate
`row's column ∈ caller's allowed set` directly into the query.

You configure it purely with **data** — two keys in the app's
`apps.acls.scope` JSON blob, no new columns and no new tfl5 code:

- **`field_map`** — per resource, which column maps to which scope tier
  (e.g. `"deal": { "S": "company_id", "O": "owner_id" }`).
- **`bindings`** — per user, which scope code + values they hold
  (e.g. `"u-alice": [{ "scope": "S", "params": { "S": "acme" } }]`).

The engine is **domain-neutral**: the scope codes are just letters
(`W`/`S`/`C` = a 3-level widest→narrowest hierarchy, `M` = multi at the
narrow tier, `O` = own-records, `G` = global, `N` = none). A CRM reads
`S` as "company"; a school reads `S` as "school". Multi-role users get
their bindings UNION'd (OR).

**Read vs write.** On `/app/doc/list` the predicate is spliced into the
SQL (`AND (row's scope column ∈ allowed set)`). On
`/app/doc/{get,create,update,del}` it's evaluated in-memory against the
row's indexed data. A user with no matching binding lists **zero rows**
(the fragment becomes `FALSE`) — a silent, existence-safe empty page.

**Activation (all three must be true to enforce):**

1. Env flag `TFL5_ENFORCE_SCOPE=true` — global circuit breaker; unset =
   scope is bypassed entirely (ships dark by default).
2. Per-app opt-in — `apps.acls.scope.field_map` is non-empty.
3. The requested resource has an entry in `field_map`; if it doesn't,
   the request is default-denied (`scope_not_configured`, 400).

So for an app that hasn't opted in, L4 is a no-op and only L1–L3 apply.

### Scope vs role-tokens (§11) — both valid

| | Role-token per row (§11) | Scope (L4) |
|---|---|---|
| Grant lives on | each doc's ACL array | one `bindings` map in app config |
| "User sees rows where field X = their value" | one role + one token per distinct value, on every row | one `field_map` entry + one binding per user |
| Membership change | edit role members | edit one binding |
| Best when | small, discrete grants; ad-hoc sharing | many rows partitioned by a stable field (tenant / owner / org unit) |

Scope scales better precisely when the number of distinct values is
large: you avoid minting a role and stamping a token onto every row.
Role tokens remain the right tool for small, explicit, per-doc grants.

> This section only **introduces** scope. The full model — every scope
> code, the generic-vs-legacy keys, and the worked CRM + school examples
> — lives in **[scope.md](scope.md)**. Don't reimplement the spec here.

---

## 8. Roles — the indirection that makes scaling work

A role is a named, mutable list of `user_tid`s, scoped per-app.

```
POST /app/role/create
{ "app_tid": "a_xxx",
  "name": "homeroom_teacher_class_7A",
  "description": "...",
  "members": ["u_teacher1", "u_teacher2"] }
→ { tid: "r_homeroom7a", ... }

POST /app/role/edit
{ "app_tid": "a_xxx", "tid": "r_homeroom7a",
  "members": ["u_teacher1", "u_teacher2", "u_teacher3"] }    ← replaces full list

POST /app/role/del
{ "app_tid": "a_xxx", "tid": "r_homeroom7a" }
```

`/app/role/del` does a transactional cleanup: deletes the role row,
runs `array_remove([r_homeroom7a])` across every ACL array on `apps`
+ `files`, then invalidates app config cache. Members lose access
immediately.

### Why roles matter

Putting a `[r_<tid>]` token in an ACL array is the **only** scalable
authorization pattern at tenant scale:

- ❌ **Don't** put thousands of individual `user_tid`s in `readers`
  — array grows linearly + every membership change is N updates.
- ✅ **Do** put one `[r_<tid>]` token in `readers` + manage role
  members via `/app/role/edit` — O(1) per ACL row.

**School example:** think one role per (school × class × year). When a
teacher moves classes, update one role membership, not every attendance
row.

---

## 9. The lock-out guard — protecting Owner

Two protections built into tfl5 endpoints:

**App owner can never be locked out.**
- `apps.author` is immutable except via `/app/transfer-ownership`.
- The author column bypasses `noaccess` in the decision tree.

**Managers cannot lock each other out (except via author).**
- `/app/acl-set` enforces: non-owner Managers cannot
  (a) remove themselves from `managers`, or
  (b) add themselves to `noaccess`.
- The author (owner) is exempt from both checks. Owner can do
  anything to anyone — they retain ultimate control.

**You cannot accidentally lock the platform out of tfl5-admin.**
- The bootstrap path (`/reg` → first user becomes Manager) runs on
  every register if `tfl5-admin.managers` is empty. If you somehow
  ended up with an empty manager list, the next register fixes it.

---

## 10. ACL patching endpoints

### App-level
```
POST /app/acl-set
{ "app_tid": "a_xxx",
  "managers": ["u_alice", "[r_admin]"],          ← optional; omit = preserve
  "designers": [...],
  "editors": [...],
  "readers": [...],
  "deletable": [...],
  "noaccess": [...] }
```

Omit a field to preserve. Pass an empty array `[]` to clear. Manager
gate. Lock-out guard applies.

### Per-doc
```
POST /app/doc/acl-set
{ "app_tid": "a_xxx", "tid": "d_xxx",
  "editors": [...], "readers": [...],
  "deletable": [...], "noaccess": [...] }
```

Manager-of-app or doc author can patch. Same omit-to-preserve rules.

### Per-file
```
POST /app/file/acl-set
{ "app_tid": "a_xxx", "tid": "f_xxx",
  "managers": [...], "editors": [...],
  "readers": [...], "deletable": [...],
  "noaccess": [...] }
```

Manager-of-app or file author can patch.

### Sharing (read-only grants)
```
POST /app/share/create
{ "app_tid": "a_xxx",
  "doc_tid": "d_xxx",
  "target": "user_tid OR [r_xxx] OR G_<group> OR anonymous",
  "fields": ["field1", "field2"],        ← optional field-level whitelist
  "expires_at": 1700000000000,           ← optional ms epoch
  "resharable": false,
  "note": "..." }
→ { tid: "sh_xxx", token?: "..." }       ← `token` set when target=anonymous
```

Share = orthogonal channel; doesn't mutate the doc's own ACL.
Revocable instantly via `/app/share/revoke`. Anonymous link claim:
`POST /app/share/claim { token, app_tid? }`.

> The `fields` whitelist above is *access* control, not *confidentiality*
> — it narrows what a share exposes, but the tfl5 server can still read
> the underlying data. For the confidentiality / trust model (tfl5 is
> **custodial** — the server can read stored data; it is **not**
> zero-knowledge), see **[security-model.md](security-model.md)**.

---

## 11. Role-based ACL conventions for a school management app

This section shows how to map a typical set of school roles (principal,
teacher, parent, health staff, administrator) cleanly onto tfl5's ACL
using only existing primitives — no platform changes required.

### Role naming convention

For an app `a-example` with school-management data:

| Functional role | Suggested tfl5 role name | Members | Token in ACL |
|---|---|---|---|
| School Principal | `principal_<school_id>` | Principal user_tids for that school | `[r_principal_<school_id>]` |
| Homeroom Teacher | `homeroom_<class_id>` | The one homeroom teacher | `[r_homeroom_<class_id>]` |
| Subject Teacher | `subject_<subject_id>_<class_id>` | Subject teacher(s) | `[r_subject_<subject_id>_<class_id>]` |
| Parent of Student | `parent_of_<student_id>` | 1-N parents of that student | `[r_parent_of_<student_id>]` |
| School Health Staff | `health_<school_id>` | Health staff at school | `[r_health_<school_id>]` |
| Ward Health Officer | `health_ward_<ward_id>` | Cross-school within ward | `[r_health_ward_<ward_id>]` |
| Ward Administrator | `admin_ward_<ward_id>` | Ward leadership | `[r_admin_ward_<ward_id>]` |

### Default app-level ACL

```json
{
  "managers": ["u_app_ops_admin"],
  "designers": [],
  "editors": [],                    ← per-row only; app-level open is too coarse
  "readers": ["G_author"],          ← every authenticated user can READ a doc
                                    ← in this app (subject to per-row gates)
  "deletable": [],
  "noaccess": []
}
```

Then EVERY doc carries explicit per-row arrays so visibility is gated
correctly. The `G_author` in app.readers means "to even see this app
exists, you need a session" — but actually seeing data requires
matching a per-row token.

### Per-row ACL patterns

For **student records** (`resource: student`):
```json
{ "editors":  ["[r_homeroom_<class_id>]", "[r_principal_<school_id>]"],
  "readers":  ["[r_parent_of_<student_id>]", "[r_health_<school_id>]",
               "[r_admin_ward_<ward_id>]"],
  "deletable": ["[r_principal_<school_id>]"]
}
```

For **attendance rows** (`resource: attendance`):
```json
{ "editors": ["[r_homeroom_<class_id>]"],
  "readers": ["[r_parent_of_<student_id>]", "[r_principal_<school_id>]",
              "[r_admin_ward_<ward_id>]"]
}
```

For **health events** (`resource: health_event`):
```json
{ "editors": ["[r_health_<school_id>]"],
  "readers": ["[r_parent_of_<student_id>]",
              "[r_health_ward_<ward_id>]",
              "[r_principal_<school_id>]"]
}
```

### Hard boundary: principal of school A cannot see school B's data

Because `[r_principal_school_a]` and `[r_principal_school_b]` are
distinct tokens, the principal of school A literally cannot see school
B's docs — they're not in the role membership, the token doesn't
appear in any of B's row ACLs. **No additional code needed.**

### Ward health officer spans schools

A ward-level health officer is granted `[r_health_ward_<ward_id>]`
and that token is added to readers on every health_event in that ward.
The role membership is the single source of truth for "who is the ward
health officer today."

---

## 12. Common mistakes — read before designing

1. **Don't use username in ACL arrays.** Always use `user_tid`.
   Username is for login; tid is for authorization.

2. **Don't forget brackets on role tokens.** `[r_xxx]` not `r_xxx`.

3. **Don't put thousands of user_tids in an array.** Use a role.

4. **Don't use `editors` to delegate read.** Editors can WRITE.
   Use `readers` for read-only grants.

5. **Don't assume app-level Reader = read every doc.** Per-row ACL,
   if explicit, restricts. Empty per-row = inherits.

6. **Don't try to lock out the owner.** It won't work + you'll trip
   the lockout guard's 400 response.

7. **Don't store the owner's actions in a separate "audit" array.**
   The platform's audit_log handles every mutation transparently.
   Querying `/admin/audit/list` returns it.

8. **Don't grant via the `apps.managers` array if a role works.**
   Roles are cheap and revocable; manager is heavy + lockout-tied.

9. **Don't design custom ACL columns.** This is THE most common
   foot-gun. Every authorization need so far has fit the 6-array
   model. If yours doesn't, ask tfl5 team first.

10. **Don't mix `noaccess` semantics with "deleted."** `noaccess` is
    a permission veto, not a deletion marker. Use `deleted_at` for
    soft-delete.

---

## 13. Audit + traceability

Every mutation that matters writes one row to `audit_log`. Operators
query via `/admin/audit/list` filtered by actor / target / action /
time. Roles, ACL edits, role member changes, ownership transfer — all
logged.

Hook firings write to `hook_invocations` (per Batch 56). One row per
after_* execution, success or failure.

Operator invocations (integrations) write to `op_invocations` — every
`/op/<id>/<action>` call logged.

These three tables together give you full traceability. You don't
need to add audit columns to your own resources unless the audit
requirement is FIELD-specific (vs row-specific).
