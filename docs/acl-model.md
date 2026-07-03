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

## 6. Roles — the indirection that makes scaling work

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

## 7. The lock-out guard — protecting Owner

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

## 8. ACL patching endpoints

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

---

## 9. Role-based ACL conventions for a school management app

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

## 10. Common mistakes — read before designing

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

## 11. Audit + traceability

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
