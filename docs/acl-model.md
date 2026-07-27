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
read/write must pass ALL *applicable* layers — any single layer can deny.
"Applicable" is load-bearing: see the banner below the diagram.

```
L1  App-level ACL       — 5 levels on the `apps` row (§2–§4)
        ↓  AND
L2  Resource-type ACL   — arrays on the `resources` row (§6)
        ↓  AND
L3  Per-row / per-doc ACL — arrays on the doc/file row (§5)
        ↓  AND
L4  Row-level scope      — field-based fencing (§7, opt-in)
```

A caller edits a doc only if L1 **and** L2 **and** L3 **and** L4 all
say yes. Emptiness is permissive: an empty L2/L3 array inherits the layer
above; L4 is off unless the app opts in. `noaccess` and the scope filter
never *grant* — they only subtract.

🚨 **L3 does not apply to doc reads.** `/app/doc/list` and `/app/doc/get`
enforce **L1 → L2 → L4 only** — they never evaluate the doc row's own
`readers` / `editors` / `noaccess` arrays. Per-doc ACL gates doc **writes**
(`update`, `del`, `acl-set`, `share/create`) and the file/F3 paths. If you
need to hide *rows* from someone who holds app-Reader, use **L2** (fence
the whole resource) or **L4 scope** (fence by a field) — not per-doc
`readers`. This is the single most important thing on this page; §5 has the
detail.

- 5 permission levels: `Owner > Manager > Designer > Editor > Reader`
- Each row that has ACL has 4-7 arrays of **tokens**: `managers`,
  `designers`, `editors`, `readers`, `deletable`, `noaccess`
  (and `authors` on resources)
- A **token** can be a `user_tid` (`u-…`), a username, a bracketed role
  token (`[r-…]`), or a group tid (`g-…`, plus the reserved `G_author`)
  — see §3
- `noaccess` is a hard veto **against ordinary grantees only**. The app
  author, app Managers, and a row's own author bypass it (lockout
  protection). Do not treat `noaccess` as a way to hide data from an admin.
- Per-doc and per-file ACL stack ON TOP of app-level ACL. Empty
  per-row ACL = inherit app-level.
- The resource-type ACL (L2) and row-level scope (L4) are the two layers
  that let you fence *categories* of data and *individual rows by field*
  without exploding role tokens.

**These four layers govern tenant data (`/app/*`).** They are not the only
gate on the platform — control-plane routes under `/admin/*` sit behind a
separate platform-admin check, and machine callers (service tokens, signed
sources) authenticate differently before landing in the same four layers.
When you design an app, the four layers are what you reason about; just
don't assume `/admin/*` is reachable with app-Manager rights.

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

**Email verification gate — much narrower than it looks.** A write-class
level (Manager / Designer / Editor) requires `users.email_verified = true`
**only when the caller is the app's `author`**. The reasoning: if you are
not the author, you reached write-class through an explicit ACL grant — the
owner already vouched for you — so you are exempt. Three more carve-outs:

- **Reader is always exempt** (browse + account recovery).
- **Users with no email on record are exempt entirely** — phone-OTP and
  VNeID sign-ups have no inbox to verify into, and would otherwise be
  permanently locked out of every write.
- **Doc CRUD skips the gate altogether.** `/app/doc/*` uses the no-email
  variant of the permission check by product decision; files and app
  creation still enforce it.

App *creation* is gated separately, so a brand-new unverified user still
cannot bootstrap their own first app — only act on apps shared with them.
When the gate does fire, the failure carries `code: "email_not_verified"`.

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

A "token" is a string entry in one of the ACL arrays. The array is
deliberately heterogeneous — it mixes four kinds of identifier:

| Form | Storage shape | Meaning |
|---|---|---|
| **user tid** | `u-<uuid>` (raw) | One specific user. |
| **username** | `<name>` (raw) | Whoever currently holds that username. Matches, but see the warning below. |
| **role token** | `[r-<uuid>]` — **bracketed** | Any user in that role's `members` array. |
| **group tid** | `g-<uuid>` (raw), or the reserved literal `G_author` | Members of a platform group. `G_author` is the synthetic "any authenticated caller" group and cannot be created or deleted. |

Note the shapes: tids are **hyphenated** (`u-`, `r-`, `g-`, `d-`, `f-`),
not underscored. Examples in this document use readable placeholders like
`u_alice` for legibility; real values are UUID-based.

**Why roles — and only roles — are bracketed.** Brackets are not
cosmetic and not a template placeholder: they prevent a
username-vs-role-tid collision. Usernames are sanitised on the way in with
`[` and `]` stripped, so a username can never equal `[r-…]`. Without the
brackets, someone could register the username `r-<known role tid>` and
match that role's grants through the username slot of their permission
set. Group and user tids need no such protection because they are
generated server-side and never come from user input.

**You usually don't have to add the brackets yourself.** The platform's ACL
write endpoints (`/app/acl-set`, `/app/acl/set`, `/app/acl/revoke`,
`/app/acl/bulk-import`) normalise a raw `r-…` input by wrapping it. The
bracketed form is the canonical storage shape, and it is what you will see
when you read an ACL back. If you write to an ACL array through some other
path, wrap it yourself — an unbracketed role tid matches nothing.

⚠ **Prefer `user_tid` over username.** Both match, but usernames are
mutable (`/user/username/change`). A username sitting in an ACL array
follows whoever holds that username *next*, not the person you meant to
grant. Tids never change.

### When a user makes a request, their effective permission set is:

```
perms = [
  for each role they're in:    "[<role-tid>]",   # bracketed
  for each group they're in:   "<group-tid>",    # raw
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
1. Resolve the caller. NOT cookie-only: the session `_token` cookie,
   an `Authorization: Bearer <service token>`, an edge-signed header,
   or the cluster token all land here. No valid identity → Unauthorized.
2. Cluster bypass: the `_cluster` service principal passes EVERY level
   immediately, skipping steps 3-8 entirely (see §14).
3. Re-check the user row live: no such user, or banned → Unauthorized.
   (This defeats the short-lived ACL cache — a ban takes effect at once.)
4. SELECT author, managers, designers, editors, readers,
        deletable, noaccess FROM apps WHERE tid = $app_tid
5. If the row doesn't exist → AccessDenied
6. Normalize tids (legacy `u_<hex>` folds to canonical `u-<hex>`)
7. Decide:
   a. If caller.user_tid == row.author → PASS (owner bypass)
   b. If level == Owner → DENY (only author passes Owner)
   c. If any token in row.noaccess matches caller.perms → DENY
   d. Test against the level's allowed arrays:
      - Manager: managers
      - Designer: managers OR designers
      - Editor:   managers OR designers OR editors
      - Reader:   managers OR designers OR editors OR readers
      If any match → PASS
8. Email gate — only when level != Reader AND caller IS the author (§2)
```

**Owner bypass.** The author always passes — including the `noaccess`
check. This is the lockout protection: even if a malicious co-manager
adds the author to `noaccess`, the author can still administer the app.

**noaccess wins over everything except author.** Even a Manager in
both `managers` AND `noaccess` is denied (`noaccess` evaluated first at
the *app* level — note this ordering is reversed at the row level, §5).

**A denial is HTTP 200.** `AccessDenied` returns `200` with
`{result: false, msg: "Access denied", code: "access_denied"}`; `NotFound`
likewise returns `200` with `code: "not_found"`. Check `result` and `code`,
never the HTTP status. (See README → Quirks.)

---

## 5. Per-row ACL — docs + files

Some rows (docs, files) carry their own ACL arrays. These layer on
top of app-level:

**For docs (`docs` table):** `editors`, `readers`, `deletable`,
`noaccess` + `author` (column). Docs have **no** `managers` or `designers`
column.

**For files (`files` table):** `managers`, `editors`, `readers`,
`deletable`, `noaccess` + `author`.

### 🚨 Where this layer actually runs

| Path | Per-doc ACL evaluated? |
|---|---|
| `/app/doc/list` | **No** |
| `/app/doc/get` | **No** |
| `/app/doc/update` | Yes (Editor) |
| `/app/doc/del` | Yes (Editor **plus** a `deletable` cross-check) |
| `/app/doc/acl-set` | Yes (Editor, then owner/manager-or-author) |
| `/app/share/create` | Yes (Editor on the doc being shared) |
| `/app/file/*`, `/app/f3/*` | Yes |

Read paths are gated by L1 + L2 + L4 and then return the row. **Putting a
user in a doc's `noaccess` does not stop them reading that doc** if they
hold app-level Reader and clear the resource ACL and scope. Design
accordingly: fence reads with §6 (resource ACL) or §7 (scope).

### Decision order for per-doc / per-file (on the paths that do run it):

```
1. Caller must pass app-level Reader check (gates probing).
2. If caller == row.author OR caller is app owner/manager → PASS.
3. If row.noaccess matches caller.perms → DENY (hard veto).
4. If row has ANY non-empty explicit editors/readers/deletable array:
   - Reader: row.editors OR row.readers OR row.deletable
   - Editor: row.editors
   - Manager/Designer/Owner at row level → DENY (not meaningful here)
5. If row has NO explicit ACL → inherit: Reader passes (already proven
   at step 1); other levels re-run the app-level decision.
```

⚠ **Steps 2 and 3 are in that order deliberately.** The row author and the
app owner/manager bypass `noaccess` — you cannot use a doc's `noaccess`
array to hide it from an app Manager or from the person who wrote it. This
is the same unrescindable-recovery principle as the app-level owner bypass.

**Key insight:** **empty per-row ACL means inherit**, not "deny." A doc
with all four arrays empty is visible to anyone with app-level Reader.

**Per-row ACL can GRANT additional write access.** A doc with `editors:
[u_bob]` makes Bob an editor even if Bob is only an app-level Reader.
This is the row-scoping mechanism for fine-grained delegation.

**Per-row `noaccess` restricts writes, not reads.** A doc with `noaccess:
[u_carol]` blocks Carol from updating or deleting it — but does not hide it
from her `list`/`get`.

**Email gate at row level.** The row-level check has its own email gate for
non-Reader levels, but every `/app/doc/*` endpoint uses the no-email
variant, so in practice it only fires on the F3 file paths.

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
It is wired on **every** doc path:

| Doc op | L2 level asked |
|---|---|
| `/app/doc/list` | Reader |
| `/app/doc/get` | Reader |
| `/app/doc/create` | Editor |
| `/app/doc/create-batch` | Editor |
| `/app/doc/upsert` | Editor |
| `/app/doc/import` | Editor |
| `/app/doc/update` | Editor |
| `/app/doc/del` | Editor |

Note `/app/doc/acl-set` is the one doc endpoint that does **not** consult
L2. And the `deletable` cross-check on delete happens at the **doc** layer
(§5), not here — L2 asks plain `Editor` for a delete, which consults
`resources.editors` only.

Decision inside `resource_acl_allows`:

```
1. `_cluster` synthetic user → PASS (cross-tenant orchestration bypass).
2. If the resource row doesn't exist → NotFound (not a deny).
3. If caller == resource.author OR caller is app owner/manager → PASS.
4. If resource.noaccess matches caller.perms → DENY.
5. If resource has NO explicit editors/readers/deletable → PASS
   (empty = permissive; inherit the app-level + per-row decision).
6. Else AND-gate the caller into the level's array:
   - Reader: editors OR readers OR deletable
   - Editor: editors
   - Manager / Designer / Owner: DENY
```

**Empty = inherit, not deny** — same rule as per-row (§5). A resource
with all positive arrays empty is fully governed by L1 + L3 + L4, so
existing resources keep behaving exactly as before until you opt in by
populating an array.

**Deny is quiet on `list`, loud on `get`.** When L2 denies a `list`, the
endpoint returns the same empty-success envelope as a zero-row page — no
existence leak. `get` and every write instead return `access_denied`. Don't
assume the whole read surface is existence-safe; only `list` is.

### Setting + reading the resource ACL

- **Read:** `POST /app/resource/get { app_tid, tid }` returns the arrays
  in `data.{editors,readers,deletable,noaccess,managers,designers,authors,author}`.
  The endpoint itself is Reader-gated, but the ACL arrays are only
  populated for an owner/manager caller; a mere Reader gets the schema
  with every array `[]` (not a denial).
- **Set:** the arrays are written through `/app/resource/create` and
  `/app/resource/update`, both Manager-gated, and both accepting exactly
  four fields: `readers`, `editors`, `noaccess`, `deletable`. There is **no
  write surface at all** for `managers` / `designers` / `authors` — another
  reason not to design around them.
  - On **update**, omitted = preserve (COALESCE), `[]` = clear.
  - On **create** there is nothing to preserve: an omitted array is created
    empty, i.e. permissive.
  - Role tids are bracket-wrapped (`[r-…]`) on the way in.
- There is **no** `/app/resource/acl-set` endpoint — use create/update.

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

1. Env flag `TFL5_ENFORCE_SCOPE` set to `1` / `true` / `TRUE` / `yes` —
   global circuit breaker; unset = scope is bypassed entirely (ships dark
   by default).
2. Per-app opt-in — `apps.acls.scope.field_map` is present **and non-empty**.
3. The requested resource has an entry in `field_map`; if it doesn't,
   the request is default-denied (`scope_not_configured`, 400).

The `_cluster` service principal bypasses scope as well. So for an app that
hasn't opted in, L4 is a no-op and only L1–L3 apply.

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

`/app/role/del` runs one transaction: delete the role row, then
`array_remove` the bracketed token from every ACL array on **`apps` and
`files`**, then invalidate the app config cache.

⚠ **The cleanup does not reach `docs` or `resources`.** A deleted role's
token stays in `docs.{editors,readers,deletable,noaccess}` and
`resources.{editors,readers,deletable,noaccess}` indefinitely. It grants
nothing — role tids are fresh UUIDs, so recreating a role with the same
*name* produces a different tid and cannot silently re-grant — but two
things follow that you should plan for:

1. **Audits get noisy.** Stale `[r-…]` tokens look like live grants when
   someone reads an ACL back. If you delete roles, sweep your own docs.
2. **Revocation is not uniform.** "Delete the role" fully revokes at the
   app and file layers, and revokes L2/L3 grants only in the sense that the
   token now matches nobody. To revoke *deliberately*, prefer emptying the
   role's `members` via `/app/role/edit` — that takes effect everywhere at
   once, because membership is what the permission set is built from.

### Why roles matter

Putting a `[r-<uuid>]` token in an ACL array is the **only** scalable
authorization pattern at tenant scale:

- ❌ **Don't** put thousands of individual `user_tid`s in `readers`
  — array grows linearly, every membership change is N updates, and the
  array is capped at 5000 entries.
- ✅ **Do** put one `[r-<uuid>]` token in `readers` + manage role
  members via `/app/role/edit` — O(1) per ACL row, and it revokes
  everywhere at once (§8).

**School example:** think one role per (school × class × year). When a
teacher moves classes, update one role membership, not every attendance
row.

---

## 9. The lock-out guard — protecting Owner

Protections built into tfl5 endpoints:

**App owner can never be locked out.**
- The author column bypasses `noaccess` at every layer.
- `apps.author` changes only through `/app/transfer-ownership` (Owner-gated).
  `/app/update` cannot touch it, and it explicitly rejects the six ACL
  arrays and the `acls` blob with `app_update_no_acl_fields`. (Two internal
  paths also normalise the column — a username change rewriting a legacy
  username-form author to a tid, and the admin bootstrap below — but neither
  transfers ownership to a different person.)

**Managers cannot lock each other out (except via author).**
- `/app/acl-set`, `/app/acl/set`, `/app/acl/revoke`, and
  `/app/acl/bulk-import` all enforce: a non-owner Manager cannot
  (a) remove themselves from `managers`, or (b) add themselves to
  `noaccess`. The check runs against the caller's **full** permission set —
  so you can't dodge it by holding your grant through a role.
- The author (owner) is exempt from both checks. Owner can do
  anything to anyone — they retain ultimate control.

⚠ **`/app/member/*` uses a different guard.** `set-direct-grants` protects
against *vertical* escalation by scaling the level it demands to the array
being touched — `managers` requires Owner, `designers` requires Manager,
everything else (including `noaccess`) requires Designer. It does **not**
run the self-lockout guard, and `remove` protects only the author. So a
Designer can put a Manager — or themselves — into `noaccess` through this
endpoint. Grant Designer accordingly, and prefer `/app/acl/*` for ACL
editing if you want the self-lockout guard.

**You cannot accidentally lock the platform out of `tfl5-admin`.**
- A bootstrap promotion fires when `tfl5-admin.managers` is NULL, empty, or
  the legacy `['system']` placeholder: the acting user is installed as
  Manager. It runs on registration *and* on the `/user` endpoint, so an
  existing account is promoted on its next authenticated call. The update is
  conditional in SQL, so two concurrent registrations cannot both win.

---

## 10. ACL patching endpoints

### App-level
```
POST /app/acl-set
{ "app_tid": "a_xxx",
  "managers": ["u-<uuid>", "[r-<uuid>]"],        ← optional; omit = preserve
  "designers": [...],
  "editors": [...],
  "readers": [...],
  "deletable": [...],
  "noaccess": [...] }
```

Omit a field to preserve. Pass an empty array `[]` to clear. Manager
gate. Lock-out guard applies.

### App-level, incrementally

`/app/acl-set` replaces all six arrays at once, which is awkward for an
admin UI. Four incremental endpoints exist, all Manager-gated, all with the
same bracket-normalisation, the same 5000-entry-per-array cap, and the same
lock-out guard:

```
POST /app/acl/list          { app_tid }                     → the six arrays
POST /app/acl/set           { app_tid, bucket, members }     ← replace ONE bucket
POST /app/acl/revoke        { app_tid, bucket, member }      ← remove one principal
POST /app/acl/bulk-import   { app_tid, ... }                 ← several buckets at once
POST /app/role/list-for-user { app_tid, user_tid }           ← Manager OR self
```

There is also a people-centric surface — `/app/member/{list,get,set-roles,
set-direct-grants,remove}` — for rendering "who has access to this app".
Read the caution in §9 before granting Designer.

### Per-doc
```
POST /app/doc/acl-set
{ "app_tid": "a_xxx", "tid": "d_xxx",
  "editors": [...], "readers": [...],
  "deletable": [...], "noaccess": [...] }
```

Requires Editor on the doc, and then the caller must be app owner/manager
**or** the doc's author. Omit-to-preserve. A scope check on the current row
applies, so a narrowly-scoped Manager can't rewrite ACL on rows outside
their lane.

### Per-file
```
POST /app/file/acl-set
{ "app_tid": "a_xxx", "path": "assets/report.pdf",
  "stage": "release",                    ← optional
  "managers": [...], "editors": [...],
  "readers": [...], "deletable": [...],
  "noaccess": [...] }
```

Three things differ from the per-doc endpoint — all easy to get wrong:

1. It addresses the file by **`path`** (plus optional `stage`), not by tid.
2. **App-Manager only.** Unlike per-doc, the file's author gets nothing.
3. **It is a full replace, not a patch.** An omitted array is written as
   `[]`, i.e. **cleared**. Always send all five arrays.

### Sharing (read-only grants)
```
POST /app/share/create
{ "app_tid": "a_xxx",
  "doc_tid": "d_xxx",
  "target": "<user_tid> | [r-…] | <g-…> | G_author | anonymous",
  "fields": ["field1", "field2"],        ← optional field-level whitelist
  "expires_at": 1700000000000,           ← optional ms epoch
  "resharable": false,
  "note": "..." }
→ { tid: "sh-…", target, token }         ← `token` is a random hex string
                                            when target = "anonymous",
                                            otherwise an empty string ""
```

Creating a share requires **Editor on that doc** (a per-doc check, not just
app-level), and the resource must not have sharing switched off. Share is an
orthogonal channel; it doesn't mutate the doc's own ACL.

Revoke with `POST /app/share/revoke { app_tid, tid }` — note this is gated
at app-level Editor, which is *weaker* than create, so anyone who can edit
in the app can revoke any share. A missing share returns
`code: "share_not_found"`.

Anonymous link claim: `POST /app/share/claim { app_tid, token }` — **both
fields are required**, and this is the one unauthenticated endpoint in the
family.

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

> ⚠ **Read §5 first.** The per-row arrays below govern **writes**. They do
> **not** filter `/app/doc/list` or `/app/doc/get`. A design like this one
> — where "who may read this student record" is expressed as per-row
> `readers` — needs one of the two read-fencing layers underneath it to
> actually hide anything:
>
> - **Resource ACL (§6)** if the boundary is a whole resource type
>   ("only health staff touch `health_event` at all"), **or**
> - **Scope (§7)** if the boundary is a field every row already carries
>   (`school_id`, `class_id`, `parent_id`) — which is the natural fit for
>   everything below, and is why [scope.md](scope.md) exists.
>
> Treat the role/token layout in this section as the **write** model and
> the delegation vocabulary; pair it with scope for reads.

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

### Hard boundary: principal of school A cannot touch school B's data

Because `[r_principal_school_a]` and `[r_principal_school_b]` are
distinct tokens, the principal of school A cannot **write** school B's
docs — they're not in the role membership, so the token doesn't match.

For **reads**, this token layout alone is not the boundary (§5). Make the
fence real one of two ways:

- **Scope (recommended here):** declare `school_code` as the fenced column
  for these resources and bind each principal to their own school. Reads
  then carry `AND school_code = <theirs>` in SQL — out-of-scope rows never
  leave the database.
- **Resource ACL:** put `[r_principal_school_a]` in `resources.readers` and
  give each school its own resource. Coarser, but it does gate reads.

### Ward health officer spans schools

A ward-level health officer is granted `[r_health_ward_<ward_id>]`
and that token is added to readers on every health_event in that ward.
The role membership is the single source of truth for "who is the ward
health officer today."

---

## 12. Common mistakes — read before designing

1. **Don't use username in ACL arrays.** A username *does* match — but
   usernames are changeable, so the grant silently follows whoever holds
   the name next. Use `user_tid`.

2. **Don't hand-write a role token without brackets.** The canonical form
   is `[r-<uuid>]`. The platform's own ACL endpoints add the brackets for
   you; anything else writing that array must add them, or the token
   matches nothing.

3. **Don't put thousands of user_tids in an array.** Use a role.
   (Arrays are capped at 5000 entries anyway.)

4. **Don't use `editors` to delegate read.** Editors can WRITE.
   Use `readers` for read-only grants.

5. **Don't assume per-doc `readers` / `noaccess` hides a row on read.**
   It does not — see the banner in §1 and the table in §5. Anyone with
   app-level Reader who clears the resource ACL and scope reads the row.
   Fence reads with the resource ACL (§6) or scope (§7).

6. **Don't try to lock out the owner.** It won't work + you'll trip
   the lockout guard.

7. **Don't store the owner's actions in a separate "audit" array.**
   The platform's audit log records every mutation. As a tenant you read
   it with `POST /app/audit/list` (Manager on your app);
   `/admin/audit/list` is platform-admin only and is not available to you.

8. **Don't grant via the `apps.managers` array if a role works.**
   Roles are cheap and revocable; manager is heavy + lockout-tied.

9. **Don't design custom ACL columns.** This is THE most common
   foot-gun. Every authorization need so far has fit the 6-array
   model. If yours doesn't, ask tfl5 team first.

10. **Don't mix `noaccess` semantics with "deleted."** `noaccess` is
    a permission veto, not a deletion marker. Use `deleted_at` for
    soft-delete.

11. **Don't rely on the HTTP status code.** A denial is HTTP 200 with
    `{result: false, code: "access_denied"}`. Branch on `result`/`code`.

12. **Don't treat role deletion as revocation of every grant.** Empty the
    role's `members` instead — see §8.

---

## 13. Audit + traceability

Every mutation that matters writes one row to the audit log. Roles, ACL
edits, role member changes, ownership transfer — all logged, with a
server-resolved actor.

- **As a tenant**, read it with `POST /app/audit/list` — Manager on your
  own `app_tid`. The tid you authorise against is also the query scope, so
  there's no way to read another app's trail through it. Payloads are
  omitted unless you pass `include_payload`; the window is capped at 90
  days per call.
- `/admin/audit/{list,get,summary,verify}` is the platform-wide view and is
  **platform-admin only** — not reachable with app-Manager rights.

Hook firings write to `hook_invocations` (one row per `after_*` execution,
success or failure) and operator invocations write to `op_invocations` (one
row per `/op/<id>/<action>` call). Both writes are **best-effort**: a
failure is logged and the request still succeeds, so treat them as evidence
rather than as a guaranteed ledger.

Together these give you traceability without adding audit columns to your
own resources — unless your requirement is FIELD-specific rather than
row-specific. The tamper-evidence properties (and their honest limits) are
in [security-model.md §6](security-model.md).

---

## 14. Callers that are not a logged-in person

The four layers describe a human with a session. Four other principals
reach the same endpoints, and you should know they exist:

| Principal | How it authenticates | Effect on the four layers |
|---|---|---|
| **Platform admin** | app-Manager on the fixed `tfl5-admin` app | Not a 6th level. `/admin/*` pins the app id to that constant, so no other app's Manager can reach it. `/admin/*` additionally requires a fresh 2FA verification when the account has 2FA enrolled. |
| **Service token** | `Authorization: Bearer st_…`, SHA-256 stored, revocable, optional TTL | Full ACL evaluation **as its bound user** — the token is that user. Tokens carry a `scopes` list, but it is stored for forward-compatibility and **not enforced today**: a token grants everything its user can reach. Mint narrowly-privileged users, not narrowly-scoped tokens. |
| **Signed source** (`/ingest/:source_tid`) | HMAC-SHA256 over `timestamp . body` with a replay window | **Does not bypass ACL.** The signature establishes identity; the write then runs as an auto-provisioned service principal through the ordinary app-level Editor check. |
| **`_cluster`** | the deployment's cluster token | The widest bypass in the system: passes `require_app_perm` at every level, the resource ACL, the scope filter, and the admin 2FA gate. It exists for cross-tenant platform orchestration. Nothing in a tenant app can obtain it. |

**Entitlements are not a fifth authorization layer.** The service/entitlement
engine and app-creation rights resolve *how much* a subject may do (quota,
rate limits, app-create rights bought in packs) and sit in the same request
path — but they never decide *who may see which row*. A quota failure is a
quota error, not an ACL denial.
