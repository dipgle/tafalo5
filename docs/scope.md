# Row-level scope — field-based access fencing

> The **4th authorization layer** in tfl5 (see [acl-model.md](acl-model.md) for the
> other three: app-level → resource-type → per-row ACL). Scope answers a
> different question than ACL: not *"is this user an editor?"* but *"of the rows
> this user could otherwise touch, which ones are **in their lane**?"*
>
> Scope is **opt-in and domain-neutral** — the engine knows nothing about
> schools or companies; it just enforces *"row's column X ∈ the caller's allowed
> set"*, configured entirely with per-app **data** (no backend change, no schema).

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
   in-scope (so you can't scope-move a row out from under yourself).

Edge cases (all fail-safe):
- User has **no** bindings → sees **zero** rows (deny-by-default).
- A binding maps to a column missing from `field_map` → that binding is dropped to
  `Never` (no crash, no accidental open).
- A **`G`** binding matches every row (use sparingly — that's "see everything").

---

## 6. Activation — scope ships **dark** by default

Three conditions, **all** required, before scope enforces anything:

1. **Env flag** `TFL5_ENFORCE_SCOPE=true` on the cell (global circuit-breaker; unset
   ⇒ scope is bypassed entirely, so you can ship config first, enforce later).
2. **Per-app opt-in** — `apps.acls.scope.field_map` is non-empty. Apps that never
   set it are unaffected even when the flag is on.
3. **Resource in `field_map`** — a resource with no entry is **default-deny** for a
   scoped app (rather than silently open).

The `/app/doc/list` response carries `meta.scope_filter_applied` so you can confirm
enforcement is live for a given call.

---

## 7. Endpoints

**`POST /app/scope/get`** — Designer-level. `{ app_tid }` →
`{ field_map, my_bindings }` (returns only the **caller's own** bindings, never
other users').

**`POST /app/scope/set`** — Designer-level. Three patch modes:
```jsonc
{ "app_tid": "a_xxx",
  "field_map": { ... },              // replace the whole field_map (omit = keep)
  "bindings":  { ... },              // replace ALL bindings
  "bindings_patch": {                // OR: per-user patch (merge/clear one user)
     "u-alice": [ ... ],             //   set alice's bindings
     "u-bob":   null                 //   clear bob's bindings
  } }
→ { app_tid, bindings_count, field_map_size }
```
Validation errors: `scope_field_map_invalid`, `scope_bindings_invalid`,
`scope_bindings_patch_invalid`.

---

## 8. Scope carries a PII level too

A binding may declare a **PII level** that masks sensitive fields on read even for
an in-scope row (e.g. an aggregate role that may count students but not see names).
When multiple bindings match a row, the caller gets the **least-strict** level.
See [security-model.md](security-model.md) for the field-level encryption + masking
model this rides on.

---

## 9. Gotchas

1. **Scope is `AND`-ed with ACL, not instead of it.** A caller still needs
   app-level Reader + resource-ACL + per-row ACL. Scope only *subtracts* rows.
2. **`field_map` columns must be columns the row actually has** (they live in
   `data_indexed` / the row's fenced field). A typo → that binding becomes `Never`.
3. **No bindings = no rows.** Don't forget to bind a user, or they see nothing.
4. **`G` is "see everything"** — reserve it for admin/service roles.
5. **It's opt-in and env-gated** — verify `meta.scope_filter_applied` is `true`
   before trusting the fence in a security-sensitive flow; on a cell with
   `TFL5_ENFORCE_SCOPE` unset, scope does nothing.
