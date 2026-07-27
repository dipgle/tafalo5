# Row-level scope — field-based access fencing

> The **4th authorization layer** in tfl5 (see [acl-model.md](acl-model.md) for the
> other three: app-level → resource-type → per-row ACL). Scope answers a
> different question than ACL: not *"is this user an editor?"* but *"of the rows
> this user could otherwise touch, which ones are **in their lane**?"*
>
> Scope is **opt-in and domain-neutral** — the engine knows nothing about
> schools or companies; it just enforces *"row's column X ∈ the caller's allowed
> set"*, configured entirely with per-app **data** (no backend change, no schema).
>
> ⭐ **Scope is one of only two layers that fence doc READS.** Per-doc ACL
> arrays are not evaluated on `/app/doc/list` or `/app/doc/get`
> ([acl-model.md §5](acl-model.md)), so if your requirement is "user A must not
> *see* user B's rows", scope (or a resource-level ACL) is how you get it — not
> `docs.readers`.

---

## 1. Why scope exists (vs a role token per row)

[acl-model.md §11](acl-model.md) shows the pure-ACL way to fence a school: mint one
role per `(school × class × student)` and drop `[r_...]` tokens onto every row.
That works, but it explodes when the fence is a **data field** every row already
carries:

- 5,000 students × a `parent_of_<id>` role each = 5,000 roles to mint and keep in
  sync, and every attendance row needs the right token stamped on write.
- With scope you declare **once**: *"the `student` resource is fenced by its
  `parent_id` column; a parent is bound to their own ids"* — and the server
  automatically appends `AND parent_id = ANY(<this parent's ids>)` to every read.
  New rows are fenced by their data, not by a token someone remembered to stamp.

Use **role tokens** (ACL) for *"who can act on this KIND of thing"* and coarse
membership. Use **scope** for *"which ROWS, by a field the data already has"* —
multi-tenant SaaS (`company_id`), org hierarchies (`region → team → own`),
per-owner records (`owner_id`). They **compose**: both must pass.

---

## 2. The config: `apps.acls.scope`

Scope lives in the app's `acls` JSONB blob under `scope`, with two keys:

```jsonc
"scope": {
  "field_map": {
    "<resource_ma>": {          // one entry per resource you want fenced
      "S":  "company_id",       // column for scope tier S
      "O":  "owner_id",         // column for "own records"
      "own_param": "owner_ids"  // params key holding the O id-list
    }
  },
  "bindings": {
    "<user_tid>": [             // what each user is allowed to see
      { "scope": "S", "params": { "S": "acme" },              "role_code": "cs"  },
      { "scope": "O", "params": { "owner_ids": ["u-bob"] },   "role_code": "rep" }
    ]
  }
}
```

- **`field_map`** maps each **resource** to which **column** implements each scope
  tier. Set it, and that resource is opted into scope.
- **`bindings`** maps each **user** to a list of grants. A grant names a **scope
  code** + the **value(s)** the user is allowed. Multi-role users ("kiêm nhiệm")
  get all their bindings **OR-ed** (union).

You read/write this via [`/app/scope/get`](api-reference.md) and
[`/app/scope/set`](api-reference.md) (Designer-level) — see §7.

---

## 3. Scope codes — a fixed, domain-neutral vocabulary

A binding names a **code**; the engine maps it to `field_map[code] = params[code]`:

| Code | Shape | Resolves to |
|------|-------|-------------|
| `G`  | global               | matches **every** row (this binding) |
| `W`  | tier-1 (widest)      | `field_map["W"] = params["W"]` |
| `S`  | tier-2               | `field_map["S"] = params["S"]` |
| `C`  | tier-3 (narrowest)   | `field_map["C"] = params["C"]` |
| `M`  | multi at tier-3      | `field_map["C"] = ANY(params["M"])` |
| `O`  | own records          | `field_map["O"] = ANY(params[own_param])` |
| `N`  | none                 | matches **no** row (hard block) |

`W`/`S`/`C` are just a **3-level containment hierarchy**, widest → narrowest — use
as many as you need. `M` is the multi-value form of `C`. `O` fences to a list of
ids the caller owns. **The letters carry no built-in meaning** — a CRM reads `S`
as "company" and `C` as "team"; a school reads `W`/`S`/`C` as "ward / school /
class". Pick whichever tiers fit; ignore the rest.

### Generic vs legacy keys (both accepted)

Each code resolves its column + value **generically first** (keyed by the code
itself), then falls back to a **legacy school-flavoured alias**. Both forms work
forever, so older configs keep running unchanged:

| Code | Generic column key | Legacy alias | Generic params key | Legacy params key |
|------|--------------------|--------------|--------------------|-------------------|
| `W`  | `"W"`  | `"ward"`      | `"W"` | `"ward_code"`   |
| `S`  | `"S"`  | `"school"`    | `"S"` | `"school_code"` |
| `C`  | `"C"`  | `"class"`     | `"C"` | `"class_code"`  |
| `M`  | `"C"` (col) | `"class"` | `"M"` | `"class_codes"` |
| `O`  | `"O"`  | `"own_field"` | via `own_param` | via `own_param` (default `"student_ids"`) |

**New apps: use the generic keys** (`"S"`, `"O"`, …) and stay domain-neutral.

---

## 4. Two complete examples

### CRM — users see only their company's rows; reps see only their own

```jsonc
"scope": {
  "field_map": {
    "deal": { "S": "company_id", "O": "owner_id", "own_param": "owner_ids" }
  },
  "bindings": {
    "u-alice": [ { "scope": "S", "params": { "S": "acme" },            "role_code": "cs"  } ],
    "u-bob":   [ { "scope": "O", "params": { "owner_ids": ["u-bob"] }, "role_code": "rep" } ]
  }
}
```
→ Alice reads every `deal` where `company_id = 'acme'`; Bob reads only deals where
`owner_id = 'u-bob'`. No role tokens, no per-row stamping.

### School — parent sees own child; teacher sees own class; ward officer spans a ward

```jsonc
"scope": {
  "field_map": {
    "student": { "W": "ward_code", "S": "school_code", "C": "class_code",
                 "O": "student_id", "own_param": "student_ids" }
  },
  "bindings": {
    "u-parent":  [ { "scope": "O", "params": { "student_ids": ["s-101"] } } ],
    "u-teacher": [ { "scope": "C", "params": { "class_code": "7A1" } } ],
    "u-ward":    [ { "scope": "W", "params": { "ward_code": "NgocHa" } } ],
    "u-multi":   [ { "scope": "M", "params": { "class_codes": ["7A1","7A2"] } } ]
  }
}
```

---

## 5. How resolution works

On every `/app/doc/*` call for a fenced resource:

1. The server loads the caller's bindings for that app.
2. Each binding compiles to a predicate (`col = value`, or `col = ANY(list)`,
   or `Always`/`Never`). Bindings are **OR-ed** (a user with two bindings sees the
   union).
3. On **reads** the predicate is `AND`-ed into the SQL `WHERE` — out-of-scope rows
   simply don't come back (no existence leak).
4. On **writes** it's checked in-memory against the row: create needs the new row
   in-scope; update needs **both** the current row **and** the post-merge row
   in-scope (so you can't scope-move a row out from under yourself). `upsert` and
   `create-batch` apply the same double check; `del` and `acl-set` check the
   current row only.

The predicate is evaluated against the row's **level-0 (unencrypted) fields**.
A scope column must therefore be declared `level: 0` — an encrypted field cannot
fence anything, because the server would have to decrypt every row to filter.

Edge cases (all fail-safe):
- User has **no** bindings → sees **zero** rows (deny-by-default), not an error.
- A binding maps to a column missing from `field_map` → that binding degrades to
  `Never` and a warning is logged (no crash, no accidental open).
- A **`G`** binding matches every row (use sparingly — that's "see everything").
- On update, the post-merge check only runs when the request actually carries a
  `data` body. An ACL-only update skips it — harmless, since nothing can move.

---

## 6. Activation — scope ships **dark** by default

Three conditions, **all** required, before scope enforces anything:

1. **Env flag** `TFL5_ENFORCE_SCOPE` on the cell, set to `1`, `true`, `TRUE`, or
   `yes` (global circuit-breaker; unset ⇒ scope is bypassed entirely, so you can
   ship config first and enforce later). It is read from the process environment
   on every request, so flipping it needs no restart of your app.
2. **Per-app opt-in** — `apps.acls.scope.field_map` is present *and* non-empty. An
   empty object counts as not opted in. Apps that never set it are unaffected even
   when the flag is on.
3. **Resource in `field_map`** — a resource with no entry is **default-deny** for a
   scoped app (rather than silently open): `scope_not_configured`, HTTP 400.

There is a fourth bypass you can't trigger from a tenant app: the `_cluster`
platform service principal skips scope entirely.

**Confirming it's live.** The `/app/doc/list` response carries
`meta.scope_filter_applied`. Note the shape of that signal:

- When scope is **not** enforced (flag off, app not opted in, `_cluster`), there is
  **no `meta` key at all** — so "`scope_filter_applied` is absent" means *not
  enforced*, which is exactly the case you must not mistake for a pass.
- When enforced, its value is an object such as
  `{"enforced": true, "bindings_count": 2, "roles": [...]}`, or
  `{"enforced": true, "reason": "no_bindings", "bindings_count": 0}` for a user
  with nothing bound.

⚠ **Scope config changes are not cache-invalidated.** Unlike the ACL endpoints,
`/app/scope/set` does not flush the app-config cache, so a change can take up to
the cache TTL to take effect. Don't write a test that sets a binding and asserts
the fence in the very next request.

---

## 7. Endpoints

**`POST /app/scope/get`** — Designer-level. `{ app_tid }` →

```jsonc
{ "result": true, "app_tid": "a_xxx",
  "field_map":   { ... },   // verbatim; operator config, no PII
  "my_bindings": [ ... ],   // ONLY the caller's own bindings
  "timestamp":   1700000000000 }
```

Both fields sit at the **top level**, not under `data`. Unset scope returns
`{}` / `[]` — the same shape as a fresh app, so a sync script can treat "no
scope yet" like "no diff". Even a Designer cannot read *another* user's bindings
through this endpoint.

**`POST /app/scope/set`** — Designer-level. Three patch modes, applied in this
order (`field_map`, then `bindings`, then `bindings_patch`):
```jsonc
{ "app_tid": "a_xxx",
  "field_map": { ... },              // replace the whole field_map (omit = keep,
                                     //   null = clear to {})
  "bindings":  { ... },              // replace ALL bindings
  "bindings_patch": {                // OR: per-user patch (merge/clear one user)
     "u-alice": [ ... ],             //   set alice's bindings
     "u-bob":   null                 //   clear bob's bindings
  } }
→ { "result": true,
    "data": { "app_tid", "bindings_count", "field_map_size" },
    "timestamp": ... }
```
Validation errors (all HTTP 400): `scope_field_map_invalid`,
`scope_bindings_invalid`, `scope_bindings_patch_invalid`, and
`scope_bindings_patch_invalid_value` when a patch entry is neither an array nor
`null`.

---

## 8. Scope carries a PII level too

A binding may declare a **`pii_level`** that narrows what an in-scope row shows —
e.g. an aggregate role that may count students but not see their names. Three
values, and anything unrecognised falls back to `F`:

| Value | Meaning |
|---|---|
| `"F"` / `"Full"` | the row comes back unchanged (default) |
| `"M"` / `"Masked"` | fields listed in that resource's `pii_fields` are masked |
| `"A"` / `"Aggregate"` | the row is dropped from `list`; `get` refuses it |

When multiple bindings match a row, the caller gets the **least-strict** level
(`F` beats `M` beats `A`).

Two behaviours to design around:

- On `/app/doc/list`, `A`-level rows are **silently dropped** and the count
  appears as `meta.pii_aggregate_dropped`. An aggregate caller therefore sees a
  short page, not an error.
- On `/app/doc/get`, an `A`-level caller gets HTTP 400 `pii_aggregate_only` —
  **unless** they send an `X-Audit-Reason` header, which escalates the read to
  Full and records it with `drill_down=true` and the reason text. This is a
  deliberate break-glass path; assume an `A` role can reach Full data by stating
  a reason, and that both the escalation and the refusal are logged.

See [security-model.md §5](security-model.md) for the masking rules and the
`pii_fields` declaration this rides on.

---

## 9. Gotchas

1. **Scope is `AND`-ed with ACL, not instead of it.** A caller still needs
   app-level Reader and the resource ACL (and, on writes, the per-row ACL).
   Scope only *subtracts* rows.
2. **`field_map` columns must be columns the row actually has**, and must be
   **level 0** (unencrypted). A typo → that binding becomes `Never`.
3. **No bindings = no rows.** Don't forget to bind a user, or they see nothing —
   and it will look like an empty dataset, not a permission error.
4. **`G` is "see everything"** — reserve it for admin/service roles.
5. **It's opt-in and env-gated** — check that `meta.scope_filter_applied` is
   *present* before trusting the fence in a security-sensitive flow. A missing
   `meta` key means scope did nothing.
6. **Changes may lag the config cache** — `/app/scope/set` doesn't invalidate it.
7. **A binding's `pii_level` can still expose Full data** via the
   `X-Audit-Reason` break-glass on `/app/doc/get` (§8). It is logged, not blocked.
