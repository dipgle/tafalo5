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
- `noaccess` is a hard veto, and **who bypasses it depends on which layer's
  array you mean** — the two answers are different, so name the layer:
  - **App-level `noaccess`** (on the `apps` row): **only the app author**
    bypasses it. The author short-circuits before anything else; the veto is
    then tested *before* the level arrays, so **a Manager listed in both
    `managers` and `noaccess` is DENIED** (§4). App-level `noaccess` *can* lock
    out a Manager — that is its job.
  - **Row-level and resource-level `noaccess`** (on a doc/file row, or on the
    `resources` row): the app author, **app Managers**, and that row's own
    `author` all bypass it — those checks run *before* the veto (§5, §6). So a
    doc's `noaccess` cannot hide it from an app Manager.
  - Net: don't treat a *row's* `noaccess` as a way to hide data from an admin;
    equally, don't assume a Manager is unlockoutable — at the app level they
    are not. Only the app author is.
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
| Create / update doc, upload file | Editor (or per-row override) |
| The membership plane — `/app/member/{list,search,get}`, `/app/member/remove`; also `/app/scope/get`, `/app/domain/list` | **Designer** |
| Define resource; **all role work** — `/app/roles/list`, `/app/role/{create,edit,del}`, `/app/member/set-roles`; **binding a custom domain** — `/app/domain/{preview,add,verify}` | **Manager** |
| ACL writes — `/app/acl-set`, `/app/acl/*`, `/app/member/set-direct-grants` | **floor, raised by the bucket touched** — see §10 |
| Delete app, **un**bind a domain (`/app/domain/del`), transfer ownership, master-key rotate; **appointing a manager** | Owner |

**Don't compute this table client-side — ask the server.** `/app/get` returns
`my_level`, one of `"owner"`, `"manager"`, `"designer"`, `"editor"`, `"reader"`,
decided by walking the *same* function every gate calls. It exists because a
client **cannot** answer "what may this caller do" from the ACL arrays alone:
those hold role and group tokens the server has to resolve, so a front-end that
tries ends up maintaining a second, wrong ladder — measured as a Roles tab that
fetched Manager-only data for every viewer and showed "Failed to load", and a
Domains screen that offered an Owner-only action to a Manager. Branch your UI on
`my_level`, not on array arithmetic.

**Why all role work is Manager, and not the Editor it looks like.** A role
tid can itself sit in `apps.managers`, so handing out role editing hands
out manager appointment by proxy — gated at Designer (its prior value), a
Designer could assign a Manager-conferring role to itself. That is why
`/app/member/set-roles` carries the same Manager bar as `roles.rs`. Roles
never confer Owner (author-only), so Manager is the correct bar and not a
higher one. This is a rule people try to "fix" back down to Editor; don't.

**Binding a domain is Manager; UNbinding is Owner.** `/app/domain/add` and
`/app/domain/verify` moved down to Manager on 2026-08-17 (verify is just the
second half of binding — a re-check of the DNS on a row that is already there),
while `/app/domain/del` deliberately stayed at Owner. The asymmetry is the
point: a Manager can put the app on a hostname, only the owner can take a live
public site off the air. If you read "domains are Owner-only" anywhere — a
stale comment on the `Owner` enum still says so — it is describing the pre-
2026-08-17 shape.

**The domain-DELEGATION surface splits on a different question, and three of its
routes take no app permission at all.** Delegation is where one app lets another
app bind a sub of its hostname, so the split is *"am I using the app I
administer"* vs *"am I handing my hostname to somebody else's app"*:

| Routes | Gate |
|---|---|
| `/app/domain/request` — ask an owner for a sub | **Manager** (using your own app) |
| `/app/domain/{mode,label-rules,get-config,whitelist/*,subs-of-parent,requests/received,request/approve,request/deny,delegation/test-pattern}` | **Owner** of the parent app, **plus** the parent domain row must actually belong to that app |
| `/app/domain/reclaim-sub` | **Owner of the parent DOMAIN** — see below; the `admin_app_tid` you pass is not the thing being authorised |
| `/app/domain/delegations/received`, `/app/domain/requests/mine`, `/app/domain/request/cancel` | **no app-level permission — session identity only** |

Both Owner rows stay Owner deliberately even though `add`/`verify`/`request`
moved to Manager: approving, denying, reclaiming or opening a parent up all hand
*this* app's hostname to a *different* app, which is giving an asset away rather
than using the app you administer — not the same act, so not the same gate. On
the grouped row the second condition matters as much as the first: the parent
row's `app_tid` must equal the `app_tid` you authorised against, so you cannot
spoof a parent by passing somebody else's domain string.

⚠ **`/app/domain/reclaim-sub` is the one whose gate is easy to misread.** It
takes an `admin_app_tid` and asks Owner on it — but that call exists only to
resolve *who you are* and run the email-verified gate. The authorisation that
actually decides the request is separate: the **strict** parent of the sub you
named is looked up, and its owner must be you. So the app you name is your own,
not the parent's, and holding Owner on some app of yours grants nothing here.
(The lookup is deliberately *strict*-suffix: using a plain longest-suffix match
would let the sub stand in as its own parent and compare you against the sub's
owner instead of the parent's.)

⚠ **Read the last row correctly: those routes are not "ungated", they are
SELF-SCOPED.** Two of them take no `app_tid` at all, because they answer "what
can *I* do" rather than "what is this app configured to do", so there is no app to
gate against. Each is fenced by the caller's own identity in SQL — the listings
match `grantee_user_tid` / `requester_tid` equal to the caller, and `cancel` only
touches a row that is both yours and still `pending`, answering `not_found`
otherwise (so it is not an existence oracle for other people's requests).
`delegations/received` additionally requires a verified email. **Do not extend
that pattern to a route that does take an `app_tid`** — there, session identity
alone would be a missing gate rather than a scoped one.

**Designer is the working level of the membership plane** — not the rarity
this section used to describe. It gates every read of who has access
(`/app/member/{list,search,get}`), the removal path
(`/app/member/remove` — read §9 before you grant it), `/app/scope/get` and
`/app/domain/list`; and through the ladder's catch-all arm (§10) it is the
default for **four of the six ACL buckets**: `editors`, `readers`,
`deletable`, `noaccess`.

⚠ **Retire the old advice "when in doubt assume Manager".** It is now the
guess most likely to make an integrator hide a control from somebody who is
entitled to use it — and read the other way (§9), it badly understates what
a Designer can already do.

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

**You usually don't have to add the brackets yourself — and that now covers
every ACL write surface, not just the app-level ones.** These endpoints wrap a
raw `r-…` on the way in and drop blank entries:

| Layer | Endpoints |
|---|---|
| App | `/app/acl-set`, `/app/acl/set`, `/app/acl/revoke`, `/app/acl/bulk-import` |
| Resource (L2) | `/app/resource/create`, `/app/resource/update` |
| Per-row (L3) | `/app/file/acl-set`, `/app/doc/acl-set` |

The last two were the stragglers: until they adopted the rule, a raw `r-…`
posted to them was stored verbatim, authorised **nobody**, and still answered
`result: true`. The platform's own file-ACL picker emitted raw tids, so every
role granted through it landed inert. Fixed at the server rather than in each
client, because three write paths had already proved the convention can be
forgotten.

⚠ **Only `/app/file/acl-set` echoes the STORED arrays back.** It returns what it
wrote — a raw `r-…` comes back wrapped, a blank entry is gone — so the response
is a usable confirmation. `/app/doc/acl-set` returns only `{tid, acl_updated:
true}`: it normalises just the same, but tells you nothing about what it kept.
Re-read the doc if you need to know.

The bracketed form is the canonical storage shape, and it is what you will see
when you read an ACL back. If you write to an ACL array through some other
path, wrap it yourself — an unbracketed role tid matches nothing.

**On the app layer, an entry that names nobody is refused by name.** Three
routes run this check — `/app/acl-set`, `/app/acl/set` and
`/app/acl/bulk-import` — and answer `code: "acl_token_unknown"`, with the
offending entries listed both in `msg` and in a machine-readable `unknown`
array. It exists because the opposite was measured: a real person's username
typed in the wrong case was accepted, stored verbatim, answered `result: true`,
and the person it was meant for opened an empty dashboard. Three properties
matter when you build against it:

- **Only entries the call ADDS are checked.** An array at rest may carry
  historical junk, and refusing today's `readers` edit because `managers` still
  holds a stale token from years ago would punish the wrong person. (This is
  also why `/app/acl/revoke` doesn't run it — a revoke adds nothing.)
- `G_author` and blank entries are skipped — the first is synthetic, the second
  is dropped by normalisation anyway.
- It answers "does this string name anybody at all", **not** "may you see them".
  A caller who can edit an app's ACL can already enumerate its members, so
  nothing is leaked; equally, don't use it as a username-existence oracle,
  because it only ever echoes back tokens the caller just typed.

⚠ **The other layers do NOT run it.** `/app/file/acl-set`, `/app/doc/acl-set`
and `/app/resource/{create,update}` normalise brackets but do **not** verify that
an entry resolves to anybody: a mistyped username in a per-doc `readers` array is
stored, grants nothing, and answers `result: true`. `/app/member/set-direct-grants`
has its own, narrower check — it validates that the single `user_tid` exists
(`code: "user_not_found"`) and only when the call is *granting*, because a revoke
has to keep working against a tid that no longer resolves. So: validate your
principals before writing an L2/L3 array, or read the row back and compare.

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
6. Normalize tids (legacy `u_<hex>` folds to canonical `u-<hex>` — see the
   precondition below; it is narrower than it looks)
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

**noaccess wins over everything except author — the author is the ONLY
app-level bypass.** Being in `managers` is not one. Even a Manager listed in
both `managers` AND `noaccess` is denied, because step 7c runs before the level
arrays in 7d: the author short-circuits at 7a, everyone else meets the veto
first. This ordering is **reversed at the row and resource levels** (§5, §6),
where app Managers and the row's own author *do* bypass the veto — which is why
§1 states the two layers separately. If you find a sentence saying app Managers
bypass `noaccess` without naming a layer, it is wrong at L1; fix it rather than
reconciling it.

**The `u_` → `u-` fold has a precondition.** It fires only when the remainder
after `u_` is **at least 8 characters and every character is a hex digit or a
dash**. `u_3f2a…` folds; `u_legacy_<uuid>` does **not**, because the letters in
`legacy_` are not hex, and neither does a short ad-hoc username like `u_alice`.
That is deliberate — the rule has to separate the handful of genuinely legacy
tids from ordinary usernames that merely start with `u_`.

The fold normalises arrays that are already **in memory**. It is useless to a
"which rows can this caller reach" query, where the arrays live in Postgres and
the filter is a byte-exact array overlap against a bound parameter: there is
nothing to normalise but the caller's own token list. For those, the platform
widens the *caller* side to both spellings instead — one shared helper, called
from `/app/list`, the identity grant resolver, and `/app/member/remove`. If you
write a query that overlaps an ACL column byte-exactly, do the same, or a grant
written in the other spelling will silently miss. The security-relevant
direction is the one people forget: a `noaccess` entry in the other spelling
used to be **ignored**.

### An ACL denial is HTTP 200 — but that is no longer true of every refusal

**`code` is the field to branch on** — not the status, and not `result` alone
(see the ⚠ under the table). The line now falls here:

| Refusal | Status | `result` | `code` |
|---|---|---|---|
| ACL denial (`AccessDenied`) | **200** | `false` | `access_denied` |
| Missing row (`NotFound`) | **200** | `false` | `not_found` |
| Business refusal (`Refused`) — e.g. removing the author | its real status (**409** here) | `false` | endpoint-specific |
| Validation (`BadRequest`) | **400** | `false` | `bad_request` or a specific code |
| Service-token off-scope (§14) | **403** | `false` | `token_scope_denied` |
| Scope lookup unavailable (§14) | **503** | `false` | `token_scope_unavailable` |
| Rate limit | **429** | `false` | `rate_limit_exceeded` |
| Not authenticated (`Unauthorized`) | **401** | ⚠ `true` | `unauthorized` |

🚨 **The last row is the one that bites.** An unauthenticated refusal carries
`result: **true**` together with `isSignout: true` — the legacy SDK contract
pairs those to drive a silent re-auth rather than a failure surface. So
`if (r.result) { /* success */ }` treats "you are not logged in" as success.
Check `isSignout` (or the status) before you trust `result`.

The `400`, `401` and business-refusal statuses are all revertible **without a
redeploy** by an operator who finds an integration that depended on the old
`200` — `TFL5_LEGACY_BADREQUEST_200`, `TFL5_LEGACY_UNAUTHORIZED_200`,
`TFL5_LEGACY_REFUSAL_200`. Which means you cannot rely on the status *either
way*: on a cell with those set, the same refusal arrives as `200`. The `code` is
the only field stable across both configurations. (See README → Quirks.)

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

**Only the app's AUTHOR appoints managers — but one route bypasses that.**
- `apps.managers` is priced at **Owner** in the shared ladder, and every
  ACL-writing route asks that ladder (§10). So a non-author cannot add or
  remove a manager through `/app/acl-set` or any `/app/acl/*` endpoint at
  all: the request is refused at the gate, before the lock-out guard below
  is even consulted.
- ⛔ **`/app/member/remove` is the exception, and it is a wide one.** It
  gates at **Designer**, and it strips the target from **all seven** `apps`
  ACL columns — `managers`, `designers`, `developers`, `editors`,
  `readers`, `deletable`, `noaccess` — plus every `roles.members` list in
  the app, in one statement, with **no** lock-out-guard call anywhere in
  the handler. Its only protection is an author check.
- **Read that as: Designer can evict any manager.** A Designer can demote
  any Manager who is not the app's author in a single call — and the same
  call also clears that person's `noaccess` veto and every role membership
  they hold in the app. Grant Designer accordingly (§2).
- Asking to remove the **author** answers **409** with
  `code: "owner_protected"` — "Cannot remove the app author. Transfer
  ownership first." Both spellings of the author's tid are checked, so
  naming them in the legacy `u_<uuid>` form does not slip past the guard.

**The lock-out guard — three checks, and it is now the second line.**
`/app/acl-set`, `/app/acl/set`, `/app/acl/revoke` and `/app/acl/bulk-import`
all run it. A non-author caller cannot **(a)** remove *themselves* from
`managers`, **(b)** add *themselves* to `noaccess`, or **(c)** remove the
*author* from `managers`.

- (a) and (b) are evaluated against the caller's **full** permission set,
  so you can't dodge them by holding your grant through a role.
- (c) is a **delta** check — "you did not remove the owner", not "the owner
  is present". An author may legitimately not sit in `managers` at all
  (being the author is enough), and a presence check would then reject
  every Manager's edit to an unrelated bucket. It matches by **substring**,
  because entries reach storage either raw or bracket-wrapped depending on
  which path wrote them. The message is "You can't remove the app owner's
  manager access".
- The author is exempt from all three — Owner retains ultimate control.

⚠ **The guard is now defence-in-depth, not the wall.** Since `managers`
became Owner-gated, a non-author cannot reach that bucket in the first
place. The guard stays because a *gate* is per-route and a new route can
forget to ask for it, whereas every write in that module passes through the
guard.

⚠ **`/app/member/*` guards differently.** `set-direct-grants` prices the
level it demands by the array being touched — the same ladder as §10, so
`managers` requires Owner, `designers` / `developers` require Manager, and
everything else (including `noaccess`) requires Designer. It does **not**
run the self-lockout guard, so a Designer can put a Manager — or
themselves — into `noaccess` through it. Prefer `/app/acl/*` for ACL
editing when you want the guard.

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

Omit a field to preserve. Pass an empty array `[]` to clear.

**Manager is the FLOOR, not the gate.** Every route that writes these
arrays asks one shared ladder, and the requirement is
`strictest(endpoint floor, ladder(buckets touched))`:

| Bucket touched | Level the ladder prices it at |
|---|---|
| `managers` | **Owner** — i.e. `apps.author` and nobody else |
| `designers`, `developers`\* | **Manager** |
| `editors`, `readers`, `deletable`, `noaccess` | **Designer** |
| *(no bucket touched)* | Designer, the same fallback as a single bucket |

Touching a high-privilege array is itself a high-privilege act, so the
requirement follows the **bucket**, not the endpoint — in either direction,
granting or revoking. A payload that touches `managers` therefore demands
Owner no matter how much Manager you hold; a payload that touches only
`readers` still demands Manager *here*, because Manager is this endpoint's
own floor and `strictest` never lowers a bar. Lock-out guard applies (§9).

\* **`developers` is retired from the ACL surface — but not from every route,
so don't call it gone.** The `apps.developers` column still exists and the
ladder above still prices it, yet the decision function **never reads it**: it
is absent from the array sets for every level, so an entry there grants
nothing. Nor can you get one there through this family — `/app/acl/{set,revoke}`
refuse the bucket name outright (`unknown_acl_bucket`), `/app/acl/bulk-import`
and `/app/acl-set` don't deserialise the field at all (an older client still
sending it has it silently dropped), and `/app/get` doesn't echo the column
back. **One route still writes it:** `/app/member/set-direct-grants` accepts
`developers` as a grant key and will happily put somebody in a column nothing
consults. Treat a populated `developers` array as historical residue, not as a
grant, and don't build a screen that offers it.

### App-level, incrementally

`/app/acl-set` replaces all six arrays at once, which is awkward for an
admin UI. Four incremental endpoints exist, all with **Manager as their
floor** — and on the three that WRITE, the same bucket ladder raising it
(above). The three writers share the same bracket-normalisation and the same
lock-out guard; the two that can make an array *grow* (`set`, `bulk-import`)
also share the 5000-entry cap (`acl_array_too_large` past it) and the
unknown-entry refusal (`acl_token_unknown`). `revoke` skips both, because a
removal cannot overflow a cap and adds nothing to check. `set` and `revoke`
name their bucket in the body, so an unrecognised one answers
`unknown_acl_bucket`; `bulk-import` takes a typed `grants` object instead, so an
unrecognised key there is **silently dropped** rather than refused — check your
spelling, because the call answers `result: true` having ignored it:

```
POST /app/acl/list          { app_tid }                     → the six arrays
POST /app/acl/set           { app_tid, bucket, members }     ← replace ONE bucket
POST /app/acl/revoke        { app_tid, bucket, member }      ← remove one principal
POST /app/acl/bulk-import   { app_tid, ... }                 ← several buckets at once
POST /app/role/list-for-user { app_tid, user_tid }           ← Manager OR self
```

🚨 **The two multi-bucket endpoints differ in WHEN the raise fires.** This
is the trap that bites hardest, because the symptom points nowhere near the
cause:

| Endpoint | Prices the… | Re-posting an **unchanged** `managers` array |
|---|---|---|
| `/app/acl-set` | **CHANGE** | free — Manager is enough |
| `/app/acl/bulk-import` | **PRESENCE** | demands **Owner** |

`/app/acl-set` compares incoming against current as **sets, after
normalisation** — order, duplicates and the two `u_`/`u-` spellings all
carry no meaning in an ACL array — so a re-save that alters nothing asks
for nothing extra. `/app/acl/bulk-import` asks only whether the key was
present in the payload at all.

**Consequence:** a "save all six arrays" dialog ported from one endpoint to
the other silently starts demanding Owner. The bug report you get will be
*"our Managers can suddenly no longer edit readers"* — accurate, and with
nothing to do with `readers`. If a screen sends whole-ACL payloads, send
them to `/app/acl-set`, or send `bulk-import` only the buckets that
actually changed.

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

7. **Don't store the owner's actions in a separate "audit" array — but do
   check what the platform log actually covers first.** ACL edits, ownership
   transfer and refusals are all there; role CRUD writes nothing, doc writes
   are opt-in per resource, and `/app/member/*` rows do not surface in the
   tenant feed at all (§13). As a tenant you read it with
   `POST /app/audit/list` (Manager on your app); `/admin/audit/list` is
   platform-admin only and is not available to you.

8. **Don't grant via the `apps.managers` array if a role works.**
   Roles are cheap and revocable; manager is heavy + lockout-tied.

9. **Don't design custom ACL columns.** This is THE most common
   foot-gun. Every authorization need so far has fit the 6-array
   model. If yours doesn't, ask tfl5 team first.

10. **Don't mix `noaccess` semantics with "deleted."** `noaccess` is
    a permission veto, not a deletion marker. Use `deleted_at` for
    soft-delete.

11. **Don't rely on the HTTP status code — and don't rely on `result` alone
    either.** An ACL denial is HTTP 200 with
    `{result: false, code: "access_denied"}`, but other refusals now carry
    real statuses (400 / 401 / 403 / 409 / 429 / 503), *and* an operator can
    turn several of those back into 200 with an env flag. Worse, an
    **unauthenticated** refusal answers `result: **true**` with
    `isSignout: true`. Branch on `code` — and check `isSignout` before you
    treat `result: true` as success. Full table in §4.

12. **Don't treat role deletion as revocation of every grant.** Empty the
    role's `members` instead — see §8.

---

## 13. Audit + traceability

App-level ACL edits, ownership transfer, app create/update/delete, service-token
mint and revoke, and the authentication events all write one row to the audit
log, with a **server-resolved** actor (never a client-supplied one).

⚠ **"Every mutation" is the wrong mental model — check coverage before you rely
on it.** Three gaps are real and none of them announce themselves:

| Mutation | Row written? | Visible in `/app/audit/list`? |
|---|---|---|
| `/app/acl-set`, `/app/acl/{set,revoke,bulk-import}` | yes (`app.acl_set`, `app.acl_revoke`) | yes |
| `/app/transfer-ownership` | yes | yes |
| `/app/member/{set-roles,set-direct-grants,remove}` | yes | **no** — see below |
| `/app/role/{create,edit,del}` | **no row at all** | n/a |
| `/app/doc/{create,update,del,…}` | **only if the resource opts in** | yes, when written |

- **Role CRUD is unaudited.** Creating, editing or deleting a role writes
  nothing. Since a role's `members` list is what every `[r-…]` grant resolves
  through, "who did I give this access to" is answerable from the ACL arrays but
  "who changed the role's membership" is not. `/app/member/set-roles` *is*
  recorded, so the member-centric path leaves a trace where the role-centric one
  does not — if that distinction matters to you, drive membership changes
  through `/app/member/set-roles`.
- **The `/app/member/*` rows are filed against the USER, not the app.** They are
  written (`member.remove`, `member.set_roles`, `member.set_direct_grants`) and
  a platform admin can see them, but the tenant feed matches rows by app tid or
  by joining a child resource — and a `user` row is neither. **So the one route
  that can strip a Manager out of every ACL array at Designer level (§9) does
  not appear in the app owner's own audit feed.** Plan for that: if you need
  membership changes in a tenant-readable trail, mirror them into a doc of your
  own.
- **Doc-write auditing is opt-in per resource.** It is off unless you set
  `audit_writes` on the resource (`/app/resource/{create,update}`), and it is
  off by default. When on, the row records **content hashes** before and after —
  not values — plus the doc tid; enough to prove a change happened and to detect
  a later edit, not enough to reconstruct what the field said.

**REFUSALS are recorded too — an app owner can see who probed them.** A
permission check that turns somebody away writes its own row: action
`app.access.denied`, `result: "failure"`, and a `detail.required_level`
naming the level the caller **lacked** (naming what they lack is what tells
an owner whether to grant it), plus `detail.doc_tid` when the refusal was
doc-level. Filter for it with `action_prefix` on `/app/audit/list`.

Three properties to know before you build on it:

- **Only callers who are somebody.** A row is written only for a request
  that carried a valid session, matched a live non-banned user, *and* named
  an app that exists. Anonymous, expired and banned callers fail earlier
  and are deliberately **not** recorded — they carry no actor to attribute,
  and one row per unauthenticated poll would drown the table the owner is
  meant to read.
- **No sampling and no dedupe**, deliberately. One account probing the same
  endpoint repeatedly is exactly the shape an owner needs to see, and
  collapsing repeats would erase it. So expect volume from a misconfigured
  client, and don't design a dashboard that assumes one row per incident.
- **No `client_ip` — but the user agent IS kept.** At that layer the only
  address available is a caller-supplied `x-forwarded-for` with no socket peer
  to validate it against, and a spoofable IP in an audit row is worse than an
  absent one. The `user_agent` header is recorded as-is; treat it as a hint, not
  as identification — it is equally caller-supplied, it is just not being
  mistaken for a network fact.

Like every other audit write it is best-effort: a failure is logged and
warned about, and the refusal is still a refusal.

- **As a tenant**, read it with `POST /app/audit/list` — Manager on your
  own `app_tid`. The tid you authorise against is also the query scope, so
  there's no way to read another app's trail through it. **The feed is not
  app-rows-only:** child-resource events (docs, resources, files, folders,
  app sources) are included, each resolved by joining that child's own
  `app_tid` column — so `target_kind` is **not** always `"app"`. The join
  matches on `tid` + `app_tid` and never on `deleted_at`, so rows for
  **deleted** children stay visible on purpose: the history of a thing
  somebody removed is precisely what an audit reader came for. Payloads are
  omitted unless you pass `include_payload`; the window defaults to 7 days
  and is capped at 90 per call.
  - 🚨 **On a `doc` row, `target_tid` is the RESOURCE's tid, not the doc's.**
    The doc tid lives in the payload as `doc_tid`, so it is only visible with
    `include_payload: true`. Filtering `target_tid` by a doc tid returns
    nothing — filter by the resource tid and read `doc_tid` off the payload.
  - **Why a join and not a `detail.app_tid` field:** `detail` is not always
    server-authored. CSP violation reports carry an anonymous caller's raw JSON
    body, and app config patches carry the tenant's own payload — either would
    let a caller write `{"app_tid": "<victim>"}` and inject rows into somebody
    else's forensic record. To match through the join you must actually own a
    child row in that app, which cannot be forged.
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
| **Service token** | `Authorization: Bearer st_…`, SHA-256 stored, revocable, optional TTL | Full ACL evaluation **as its bound user** — the token is that user, so its user's ACL is the *ceiling*. A `scopes` list narrows it **below** that ceiling: scopes **are enforced**, by a middleware ahead of the API surface (one documented carve-out), and a token used off-scope is refused **403 `token_scope_denied`** before the handler runs. See the scope gate below. |
| **Signed source** (`/ingest/:source_tid`) | HMAC-SHA256 over `timestamp . body` with a replay window | **Does not bypass ACL.** The signature establishes identity; the write then runs as an auto-provisioned service principal through the ordinary app-level Editor check. |
| **`_cluster`** | the deployment's cluster token | The widest bypass in the system: passes `require_app_perm` at every level, the resource ACL, the scope filter, and the admin 2FA gate. It exists for cross-tenant platform orchestration. Nothing in a tenant app can obtain it. |

### Service-token scopes — a path-prefix gate

A service token's `scopes` list **is enforced**. The gate is a middleware, not a
per-handler check: it runs before any handler's argument parsing, so a newly
added route on that router cannot forget to ask for it, and it decides before
any of the four ACL layers runs. Cookie sessions and non-`st_` bearers pass through untouched —
only a request actually presenting a service token pays the lookup.

⚠ **It is mounted on the main API router, and a handful of routes sit outside
that router.** They bypass the drainer for their own reasons (liveness probes,
long-lived sockets, and the rolling-update protocol that must answer *while* the
cell is drained) and, as a side effect, they are not scope-checked:
`/healthz`, `/livez`, `/metrics`, `/security/csp-report`, `/ws/chat`,
`/ws/durable/subscribe`, and the three control-plane routes
`/admin/cell/{drain,resume}` and `/admin/version/apply`. The first four carry no
tenant data and the two sockets authenticate separately, but **the three
`/admin/*` ones matter**: a scoped token whose subject is a platform admin
reaches them without its scopes being consulted. They are still gated — each one
requires platform admin, and an operator can additionally require mTLS on them —
but do not model a path scope as the fence there. Everything under `/app/*`,
`/user/*`, `/admin/*` other than those three, and the rest of the API is behind
the gate.

**A scope is a request PATH PREFIX, matched on segment boundaries** — or the
literal `*`, which means everything. `/app/bundle` permits `/app/bundle`,
`/app/bundle/upload` and `/app/bundle/activate`; it does **not** permit
`/app/bundlefoo`, which is a different route that merely starts with the
same letters. A trailing slash on the scope is ignored (`/app/bundle/` and
`/app/bundle` are the same scope — an operator's habit must not silently
lock their token out), and a **blank** entry inside a non-empty list grants
nothing.

Named capabilities (`deploy`, `data:read`) would read better and were
**considered and rejected** — don't re-propose them as a doc fix. They need
a route→capability table, some future route will not be added to that
table, and a route missing from it has to default to something: defaulting
to "allowed" leaks, defaulting to "denied" breaks callers on unrelated
routes. A path prefix has no table to forget — a route nobody wrote a scope
for matches no scope, so it is denied by construction.

### 🚨 Two grandfather clauses — check yours before you trust it

Both clauses exist so that turning the gate on was not an outage, and
**either one can leave a token you believe is restricted completely
unrestricted:**

1. **An EMPTY `scopes` list means UNRESTRICTED.** The column is
   `TEXT[] NOT NULL DEFAULT '{}'`, so every token minted before the gate
   existed carries `{}` — this clause is exactly what kept the change from
   killing every service token in production, including the ones running
   releases. Empty is a grandfather clause for rows that predate the gate,
   **not** a setting anybody should choose.
2. **A scope value the gate cannot EVALUATE does not restrict.** Only
   entries equal to `*` or starting with `/` are evaluated. A token whose
   scopes are all dot-named labels — `["app.list", "user.read"]`, the shape
   someone would have typed back when nothing read the column — is treated
   as **unscoped**, and the server logs a warning naming the values so an
   operator can migrate them.

A **mix** is enforced against the evaluable half only. A legacy label
sitting beside a path scope cannot widen it back, and a legacy label that
reaches the matcher matches nothing on its own — `app.list` does **not**
match `/app/list`.

**Consequence for you:** "my token has a `scopes` list" is not the same
claim as "my token is restricted". Read the mint response (below), or
expect a token labelled for one job to hold the whole account.

### What a caller sees

| Outcome | Status | `code` |
|---|---|---|
| Path covered by an evaluable scope | handler runs | — |
| Path outside every evaluable scope | **403** | `token_scope_denied` |
| The scope lookup itself failed | **503** | `token_scope_unavailable` |
| Unknown / revoked token | falls through to the anonymous path | — |

- The **403** body is `{result: false, msg, code, data: {path, scopes}}`.
  Note the asymmetry, because it will look like a bug: `msg` names only the
  **evaluable** scopes — the ones you can act on — while `data.scopes`
  echoes the **full stored list**, unenforceable legacy labels included. If
  those two disagree, clause 2 above is the reason.
- The **503** is a refusal, not a pass-through. Waving a request through
  because the scope lookup was unreachable would turn a transient outage
  into an authorisation bypass, which is the one failure mode this gate
  exists to stop, so it fails **closed**.
- An **unknown token is deliberately not this gate's business.** It falls
  through untouched to the ordinary anonymous path, because answering `403`
  here would make the gate a token-existence oracle — a way to tell "no
  such token" apart from "wrong scope".

These two are in §4's refusal table, and they are the earliest entries in it:
real statuses, decided before any ACL layer runs. Note also that neither is
affected by the `TFL5_LEGACY_*_200` reverts — those cover the ACL/validation
errors, not this middleware.

### Minting: the response tells you whether yours took effect

**Minting is not a tenant surface today.** `/admin/token/{mint,list,revoke}` are
all platform-admin only, so you ask your operator for a service token rather
than issuing one — and when you do, ask for **path scopes**, because the
operator typing them is the one who sees the two fields below. The subject must
be a live, non-banned user; minting against a ghost is refused at the mint, not
discovered later when the bearer path authenticates nobody.

You don't have to guess whether the scopes bite, and you shouldn't. The mint
response answers in-band with two fields:

- **`scopes_enforced`** (`boolean`) — whether this token's scopes will bite.
- **`scope_note`** (`string`) — the same answer in prose, with a distinct
  sentence per case: an empty list is called out as "**UNRESTRICTED**: it can do
  everything its subject can", while the "these are **NOT** enforced" wording is
  reserved for exactly the dangerous case — a non-empty list containing nothing
  path-shaped. That is the one an operator is most likely to misread, because
  the list *looks* like a restriction.

Read both at mint time. The plain token is shown **once**, so the person
holding it then is the last one in a position to act on those fields.

**So: prefer narrowly-SCOPED tokens.** Path scopes are the mechanism for
confining a credential to the job it was minted for — the advice this
section used to carry ("mint narrowly-privileged users, not narrowly-scoped
tokens") was written while the column was inert, and is now backwards.
Scoping is still only ever a *narrowing*: a token can never reach past what
its bound user's ACL already allows, so both halves matter — a narrow user
**and** a narrow scope.

**Entitlements are not a fifth authorization layer.** The service/entitlement
engine and app-creation rights resolve *how much* a subject may do (quota,
rate limits, app-create rights bought in packs) and sit in the same request
path — but they never decide *who may see which row*. A quota failure is a
quota error, not an ACL denial.
