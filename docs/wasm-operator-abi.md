# WASM operator ABI — the guest↔host contract

> A **WASM operator** is your own compiled code, running on tfl5's servers,
> inside your app. You upload a `.wasm` module; the platform runs it in a
> sandbox with no filesystem, no network and no clock, and hands it a JSON
> request over linear memory. The module can read and write your app's data —
> but only through host calls that run **as the end-user who triggered the
> invocation**. Reads go through the same authorization gates as
> `/app/doc/list`; writes run a narrower set — they skip the resource ACL (§8).
>
> This document is the **byte-level contract**: what your module must export,
> what the host imports give it, the exact JSON envelopes, the limits, and —
> most importantly — **what a host call is allowed to return and what it
> silently withholds**. Read §7 before you write a line of business logic.
>
> For the endpoint-level view (`/app/wasm/*`, `/op/*`) see
> [api-reference.md](api-reference.md) §Operators. For the authorization
> layers this document keeps referring to, see
> [acl-model.md](acl-model.md) and [scope.md](scope.md).

---

## 0. Scope of this document

tfl5 runs two kinds of WASM operator. **This document covers only the first.**

| Kind | Invocation | State between calls |
|---|---|---|
| **Stateless** (this document) | `POST /op/<op_id>/<action>`, or a doc-lifecycle hook | none — a fresh `Store` is built and dropped per invocation |
| **Durable / stateful** | `POST /durable/<op_id>/<instance_key>/msg` | a warm instance whose linear memory persists across messages |

The durable kind adds exports (`tfl5_snapshot` / `tfl5_restore`), a
per-message wall-clock deadline, and an oplog. Its reference is **not part of
this folder** — ask the platform team before building against it. Everything
below describes the stateless contract; the durable kind shares the base ABI
(§3–§6) but not the lifecycle.

---

## 1. The two ways your module runs

A module is inert until it is (a) uploaded, (b) activated, and (c) reachable
by one of two paths.

### 1a. HTTP dispatch — `POST /op/<op_id>/<action>`

`/op/:op_id/:action` first looks for a **compiled catalog operator** with that
id; only if none matches does it fall through to your active WASM module.

⚠ **Do not name your operator after a built-in.** The catalog currently holds
`vietqr`, `viettel-sms`, `vneid`, `zalo-zns`. An `op_id` that collides with one
of those means your module is **never reached** — the catalog operator answers
instead, and you get no error saying so.

The request body is JSON. `app_tid` is consumed by the router; **every other
top-level key is flattened into the `body` field of your request envelope**.

`<action>` is a free-form path segment; it arrives verbatim as `action` in the
envelope. The platform does not validate it against a list — dispatching on it
is your module's job.

On success the caller receives `{"result": true, "data": <your response's
data>, "timestamp": …}`.

### 1b. Doc-lifecycle hook

Add a `wasm` entry to the resource's `hooks` array:

```json
{ "id": "validate",
  "on": ["before_create", "before_update"],
  "type": "wasm",
  "params": { "op_id": "erp-validate", "action": "check" } }
```

- `params.op_id` is **required**; a `wasm` hook without it is rejected at
  resource-update time with `hook_invalid_shape`.
- `params.action` is optional and **defaults to the lifecycle event name**.
- **`before_*`** — your module receives the pending payload as `data` and may
  return a reshaped object, which *replaces* the payload.
  Returning a non-object leaves the payload untouched. Returning `ok:false`
  **blocks the write** with `wasm_rejected`.
- **`after_*`** — side-effect only. The committed doc arrives as `doc`; a
  rejection or trap is logged and **never propagated**, because the doc is
  already committed.
- A hook naming an `op_id` with **no active version is inert** — the write
  proceeds. For a `before_*` hook a warning is logged; for an `after_*` hook
  nothing is logged and the hook-invocation record shows success. Declaring the
  hook before uploading the module is therefore safe, and a typo in `op_id` is
  silent from the caller's point of view.

⚠ **The lifecycle path applies no operator-level authorization gate.** The doc
write that triggered the hook was already authorized, so there is no second
check. The **data bridge** your module gets is
still scoped to the triggering user (§7), so this is not a hole — but do not
design a hook that assumes it only runs for privileged users.

---

## 2. The sandbox

Enforced by the host on every invocation. The guest is never trusted.

| Bound | Default | Overridable |
|---|---|---|
| CPU (wasmi fuel) | 50,000,000 | per license tier |
| Linear memory | 64 MiB (a *ceiling*, grown on demand) | per license tier |
| Table elements | 100,000 | no |
| Wall clock (how long the caller waits — see §9) | 5 s | no |
| `host_call` count | 1,000 | no |
| One `host_call` request | 256 KiB | no |
| One `host_log` line | 4 KiB | no |
| Upload request size | 2 MiB (see §10) | no |

Engine is **`wasmi`**, a pure-Rust interpreter with fuel metering enabled.
Execution is deterministic; there is no JIT.

**No ambient capability.** The linker registers exactly two imports —
`host_log` and `host_call`. There is **no
WASI**, no filesystem, no sockets, no clock, no randomness. A module that
imports anything else fails to instantiate and the invocation returns
`wasm_module_invalid`.

- **Time** arrives as `now_ms` in the request envelope. There is no other
  clock. Do not import one; the module will not load.
- **Randomness** must be derived from data you were given, or fetched through
  `host_call`. There is no `getrandom`.
- **Memory growth past the cap is a denial, not a trap** — `memory.grow`
  returns `-1` and the guest keeps running. A guest that ignores the
  `-1` and writes anyway will trap on the out-of-bounds access instead. Check
  the return value of your allocator.
- **Fuel exhaustion is a trap** and ends the invocation (§9).
- **Host-call work is not charged to your fuel budget**; the 1,000-call cap and
  the 5 s wall clock are what bound it.

### Per-tier limits

Fuel and memory are resolved per invocation from the app's entitlement — a
live `wasm` service grant first, falling back to the app's license row. If
neither yields a positive pair, the constants above apply. The
wall clock and the host-call cap are **not** tier-tunable.

---

## 3. What your module must export

```wat
(memory (export "memory") 1)                                  ;; linear memory
(func (export "tfl5_alloc")  (param i32)     (result i32))    ;; size -> ptr
(func (export "tfl5_invoke") (param i32 i32) (result i64))    ;; (ptr,len) -> packed
```

- **`memory`** — your linear memory, exported so the host can read and write
  it. Both the request write and the response read go through it.
- **`tfl5_alloc(size) -> ptr`** — the host calls this to obtain a buffer, then
  writes the request JSON into it. **The guest owns the memory**; the host
  never frees it. Returning a negative pointer is an ABI error.
- **`tfl5_invoke(in_ptr, in_len) -> i64`** — the entry point. Read `in_len`
  bytes of UTF-8 JSON at `in_ptr`, do your work, write a UTF-8 JSON response
  somewhere in memory, and return a **packed pointer**:

  ```
  (out_ptr as u64) << 32 | (out_len as u64)
  ```

  Two `u32` packed into one `i64` avoids multi-value returns (not universally
  supported by guest toolchains) and avoids a second "how long was it?" call.

The host bounds-checks the returned pointer against the size of your memory
before reading. An out-of-range pair is an ABI error,
not a crash.

⚠ **Upload validation checks export *names and kinds*, not signatures.**
Upload accepts any exported function named `tfl5_invoke`. A module with
the wrong arity or types passes upload and fails at the **first invocation**
with `wasm_module_invalid` and the message
`guest exports no \`tfl5_invoke(i32,i32)->i64\``. A clean upload is not proof the ABI
is right — invoke it once before you rely on it.

Upload validation also **does not instantiate** the module, so no `start`
function runs at upload time.

---

## 4. What the host imports give you

Both are imported from module name **`"tfl5"`**.

```wat
(import "tfl5" "host_log"  (func (param i32 i32)))
(import "tfl5" "host_call" (func (param i32 i32 i32 i32) (result i32)))
```

### `host_log(ptr, len)`

Reads up to 4 KiB of UTF-8 at `[ptr, ptr+len)` and emits a **DEBUG-level**
server-side `tracing` line tagged with your `app_tid` and `op_id` (usually not
retained in production). Out-of-bounds or non-UTF-8 is **silently ignored**,
never a trap — and a line longer than 4 KiB is cut at byte 4096, so a cut in the
middle of a multi-byte character drops the whole line.

⚠ These lines go to the **platform's** server log, not to you. Do not use
`host_log` as your output channel, and **do not log secrets or personal data**
through it — you are writing into someone else's log stream. Return
diagnostics in the response `data` instead.

### `host_call(req_ptr, req_len, out_ptr, out_cap) -> i32`

The data bridge. See §6 for the protocol and §7–§8 for what it will and will
not return.

---

## 5. Request and response envelopes

Both are UTF-8 JSON. The contract is **additive-only**: new fields may appear,
existing ones will not change meaning. Ignore fields you do not know.

### Request (host → guest)

```jsonc
{
  "v": 1,                          // ABI version; reject an unknown major
  "action": "before_create",       // lifecycle event OR the <action> path segment
  "app_tid": "a_x",
  "data":    { … } | null,         // before_* payload — mutable, return it reshaped
  "doc":     { … } | null,         // after_* committed doc
  "old_doc": { … } | null,
  "body":    { … } | null,         // HTTP dispatch body (minus app_tid)
  "now_ms":  1700000000000         // the only clock you get
}
```

⚠ **There is no `user` field and no `resource` field.** An earlier version of
this document showed `"user": {"tid","roles","groups"}` and
`"resource": {"tid","ma"}` in the envelope. Those fields **do not exist** — the
envelope has the eight fields above and no more, on every invocation path. A
module that reads `req.user.roles` gets nothing.

This is not an oversight to route around; it is the design. **Your module is
not told who the caller is, and it does not need to be** — every data access
you make already runs as that user (§7). If you need the caller's identity as
*business* data, pass it in the HTTP body yourself, and treat it as untrusted
input, because it is.

Which fields are populated depends on the path:

| Path | `data` | `doc` | `old_doc` | `body` |
|---|---|---|---|---|
| HTTP dispatch | null | null | null | the request JSON minus `app_tid` |
| `before_*` hook | pending payload | null | null | null |
| `after_*` hook | null | committed doc | null | null |

### Response (guest → host)

```jsonc
{
  "ok": true,
  "data": { … },        // returned to the HTTP caller, or replaces a before_* payload
  "reject": null        // when ok=false: { "msg": "…", "code": "…"? }
}
```

`data` and `reject` may be omitted; `reject.code` is optional.

`ok:false` becomes an HTTP 400 with code **`wasm_rejected`** and your `msg` as
the message. If you set `ok:false` but
omit `reject`, the host substitutes the message
`operator rejected the request`.

⚠ **`reject.code` is not passed through to the API caller.** The response
envelope's `code` field is fixed at `wasm_rejected`; only your `msg` survives.
Put anything a client needs to branch on inside `msg`, or return `ok:true`
with a status in `data`.

⚠ **A malformed response envelope is an ABI error, not an empty result.** If
the bytes at your packed pointer do not deserialize, the invocation fails with
`wasm_module_invalid`.

---

## 6. `host_call` — the size-probe protocol

```
host_call(req_ptr: i32, req_len: i32, out_ptr: i32, out_cap: i32) -> i32
```

1. The host reads a JSON request from `[req_ptr, req_ptr+req_len)`, capped at
   256 KiB.
2. It dispatches on the request's `"fn"` key.
3. It serializes the JSON response and **returns the full response length**.
4. **The response is written only if it fits**: if the return value is greater
   than `out_cap`, *nothing was written* — allocate a buffer of that size and
   call again.

Return values:

| Return | Meaning |
|---|---|
| `n >= 0`, `n <= out_cap` | success; `n` bytes of JSON written at `out_ptr` |
| `n > out_cap` | response is `n` bytes; **nothing written**; re-alloc and retry |
| `-1` | unreadable/invalid-JSON request, response too large for `i32`, or the write to guest memory failed |
| `-2` | the per-invocation cap of 1,000 host calls was exceeded |

⚠ **A request larger than 256 KiB does not return a distinct error.** It is
truncated to the cap before parsing, the truncated bytes fail to
parse as JSON, and you get `-1` — indistinguishable from a syntax error. Keep
`where` clauses and `data` payloads well under the cap.

**Every negative return must be handled.** Treating `-1` or `-2` as "no rows"
is the single easiest way to write an operator that silently does the wrong
thing.

Two functions are available. Both take and return JSON:

```jsonc
// success
{ "ok": true,  "data": … }
// failure
{ "ok": false, "error": "…", "code": "host_query_failed" | "host_mutate_failed" | "unknown_fn" }
```


⚠ **A `public` operator has no bridge at all.** Every `host_call` returns
`{"ok":false,"error":"host data unavailable"}`, because a public operator runs
unauthenticated and there is no user to run as. Public operators are pure compute:
webhooks, callbacks, format conversion.

---

## 7. `host_query` — read, and the three gates

```jsonc
{ "fn": "query", "resource_ma": "customers", "where": {"tier":"gold"}, "limit": 50 }
→ { "ok": true, "data": [ { "tid": "d-…", "data": { …level-0 fields… } }, … ] }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `resource_ma` | yes | — | the resource's `ma` handle, within your own app |
| `where` | no | `{}` (match all in scope) | flat JSONB containment on `data_indexed` |
| `limit` | no | `100` | clamped to `1..=1000` |

Rows come back newest-first (by creation time).

**`where` is a containment filter, not a query language.** It matches level-0
(unencrypted) fields only, and it is bound as a parameter — there is no
dynamic SQL from the guest. Encrypted fields (level ≥ 1) are **never** returned and
**never** filterable: the bridge selects `data_indexed` only and never
decrypts `data_secret`.

### The guarantee, today

**`host_query` runs the same three gates, in the same order, that
`/app/doc/list` runs**, so for small result sets a module and the HTTP list
endpoint return the same rows for the same user. They are not byte-identical:

- scope is applied **after** `LIMIT` on the bridge, so a page can come back
  shorter than `limit` even when more matching rows exist;
- `limit` caps at 1000 on the bridge, 500 over HTTP;
- `where` is raw JSON containment on the bridge (no IN-lists, no field-name
  validation);
- only level-0 fields are returned (no decrypted fields, no rollups).

This was not always true. Before the fix, a module skipped the resource ACL
and collapsed the PII levels into a boolean, so a user excluded from a
resource got real rows through an operator while getting an empty list over
HTTP, and Masked/Aggregate rows came back whole. **If you are reading an older
copy of this document that says rows are "filtered by the caller's scope",
that description is stale and understated the controls.**

### Gate 1 — app permission → **error**

The host resolves the invoking user's app-permission context itself, requiring
at least **Reader**, rather than trusting the caller. Failure returns an **error
envelope**, and the denial is recorded in the platform's access-denied audit
trail.

### Gate 2 — the resource's own ACL → **silent empty array**

The resource row's own `editors` / `readers` / `deletable` / `noaccess` arrays
are consulted. Semantics:

- app owner, app manager and the resource's author always pass;
- membership in `noaccess` always denies — deny wins over any positive array;
- a resource whose positive arrays are **all empty** is permissive (this gate
  adds no restriction);
- otherwise, Reader requires membership in `editors ∪ readers ∪ deletable`.

**On denial the bridge returns an empty array, not an error**. This is deliberate: it is the same
answer the HTTP path gives, so a module cannot be used as an oracle for whether a resource holds
rows the caller may not see.

### Gate 3 — row-level scope and PII → **silent row drops and masking**

Each returned row is passed through the caller's scope filter, which returns a
**PII level**, not a boolean:

| Result | Effect on the row |
|---|---|
| no binding matched (out of the caller's cohort) | **dropped** |
| `Aggregate` | **dropped** |
| `Masked` | returned with the resource's declared PII fields masked |
| `Full` | returned unchanged |

Masking replaces values with strings — `"N.V.A"` for a name, `"****1234"` for
a phone or id number, `"a***@example.com"` for an email, and `"***"` for an
unrecognised kind string. A `pii_fields` entry whose kind is **not a string** is
skipped, and that field comes back unmasked.

⚠ **Masked rows are only masked over the fields the resource actually
declares.** Masking runs only when the resource's `pii_fields` map is
non-empty. A binding rated `M`
against a resource that declares no `pii_fields` yields the **unmodified**
row. Declaring the level is not enough; declare the fields too. See
[scope.md §8](scope.md).

⚠ **Gate 3 is conditional on deployment configuration.** Row-level scope is
off unless the platform operator sets `TFL5_ENFORCE_SCOPE` to one of
`1` / `true` / `TRUE` / `yes`,
**and** the app opts in by populating `apps.acls.scope.field_map`. When either is absent the scope resolver returns "unconstrained" and the whole per-row branch
in the bridge is skipped. `/app/doc/list` bypasses on exactly
the same condition, so **parity holds either way** — but the *strength* of the
fence does not. The parity test covers the enforce-on configuration.

Gate 3 also has an **error** mode: if the app has opted into scope but the
resource you queried has no `field_map` entry, the resolver fails closed and
you get an error envelope, not rows.

### The error-vs-silence table

This is the table to design against. **Two different denials look completely
different from inside the guest, and one of them looks exactly like success.**

| Situation | What your guest sees |
|---|---|
| Caller lacks app-Reader | `{"ok":false,…,"code":"host_query_failed"}` |
| `resource_ma` is not a live resource in this app | `{"ok":false,…,"code":"host_query_failed"}` |
| App opted into scope, resource not in `field_map` | `{"ok":false,…,"code":"host_query_failed"}` |
| **Resource ACL denies the caller** | **`{"ok":true,"data":[]}`** |
| No row matches `where` | `{"ok":true,"data":[]}` |
| Rows exist but are outside the caller's cohort | omitted from `data` — no count, no flag |
| Rows rated `Aggregate` | omitted from `data` — no count, no flag |
| Rows rated `Masked` | present, with declared fields replaced by mask strings |
| Operator is `public` (no bridge) | `{"ok":false,"error":"host data unavailable"}` |

### What you must therefore assume when writing a module

1. **An empty array is not evidence that no rows exist.** It means "nothing
   you may see", which covers ACL denial, scope exclusion, an Aggregate
   rating, and a genuinely empty resource — indistinguishably. Never branch on
   emptiness to conclude absence. In particular, do not implement
   "if no existing record, create one": you will create duplicates for
   narrowly-scoped users.
2. **What you get back is the caller's view, not the resource.** Never compute
   a total, a count, a uniqueness check, a max, or any other invariant over
   `host_query` output and treat it as a property of the data. A scoped caller
   silently gets a partial set, so your sum is silently wrong — and it will be
   right for you while you are testing as the app owner, who bypasses gate 2.
3. **Values may be mask strings.** A `Masked` row hands you `"****1234"` where
   you expected a phone number and `"***"` where you expected anything else.
   Parse defensively; never coerce a possibly-masked field to a number or a
   date.
4. **There is no way to detect that filtering happened.** `/app/doc/list`
   reports `meta.scope_filter_applied` and `meta.pii_aggregate_dropped`; the bridge response carries
   **no `meta` at all** — it is exactly `{"ok":true,"data":[…]}`. Your guest cannot check whether the
   fence ran or how many rows it dropped. Design as if it always did.
5. **Never surface "not found" to the end user from an empty result.** Say
   "no matching records are visible to you". The distinction is the whole
   point of gate 2 returning empty rather than an error — do not undo it by
   reporting absence you cannot actually observe.

---

## 8. `host_mutate` — write, and its gates

```jsonc
{ "fn": "mutate", "action": "create", "resource_ma": "ledger", "data": { … } }
→ { "ok": true, "data": { "tid": "d-…" } }

{ "fn": "mutate", "action": "update", "tid": "d-…", "data": { … } }
→ { "ok": true, "data": { "tid": "d-…" } }
```

Only `create` and `update` exist; anything else returns an error envelope. There is no delete through the
bridge.

Writes run **as the invoking user**, through the gates listed below. They do
**not** apply the resource-level ACL (`resources.editors` / `noaccess`) that
`/app/doc/create` and `/app/doc/update` apply, and they write no doc-write audit
row even on a resource with `audit_writes` on.

**`create`**:

- app-level **Editor** — an operator invoked by a Reader-only caller cannot
  write;
- field validators and link referential integrity;
- the caller's **write scope** on the level-0 payload;
- level-1+ fields are split off and encrypted; `author` is set to the invoking
  user, and the new doc's ACL arrays start **empty**.

**`update`**:

- per-doc **Editor** via the same decision function the HTTP path uses (the
  resource ACL is not checked, as for `create`);
- **write scope on both the current row and the post-merge row** — you cannot
  edit a row you cannot see, and you cannot move a row out of your own cohort;
- **`data` replaces the document's data wholesale**, matching
  `/app/doc/update`. It is not a merge. Read the row first and send the full
  object, or you will erase fields.

⚠ **Lifecycle hooks do not fire for bridge writes.** This is deliberate — it
prevents operator → hook → operator recursion. A doc your module creates through
`host_mutate` skips `before_create` / `after_create` entirely, so any
invariant you maintain in a hook will **not** be maintained for it. Enforce it
in the module too.

⚠ **A write denial is an error, not a silent no-op** — `host_mutate` failures
come back as `{"ok":false,…,"code":"host_mutate_failed"}`. Unlike
`host_query`, silence is not one of the failure modes here. Check `ok`.

---

## 9. Errors, traps, and what the API caller sees

The invocation ends in exactly one of three ways: a response envelope with
`ok:true`, a response envelope with `ok:false`, or an engine-level failure.

| Engine failure | HTTP result | `error_kind` (in the invocation log) |
|---|---|---|
| fuel exhausted | 400 `wasm_limit_exceeded` | `wasm_fuel` |
| 5 s wall clock exceeded | 400 `wasm_limit_exceeded` | `wasm_timeout` |
| module fails to load or instantiate | 400 `wasm_module_invalid` | `wasm_load` |
| missing/mistyped export, bad pointer, undecodable response, **out-of-bounds memory access** | 400 `wasm_module_invalid` | `wasm_abi` |
| any other guest trap (`unreachable`, divide-by-zero, stack overflow) | **500** | `wasm_trap` |
| host-side runtime failure | **500** | `wasm_runtime` |

There is no `error_kind` field in the response. On the 400 rows the `msg`
starts with the same tag (`wasm_fuel: …`, `wasm_timeout: …`, `wasm_load: …`,
`wasm_abi: …`); on the 500 rows the API caller sees only `code: "internal"` and
a generic message. `error_kind` itself is recorded in the operator-invocation
log. With
`TFL5_LEGACY_BADREQUEST_200` set on the cell, the 400 rows arrive as HTTP 200.

⚠ **A guest trap is a 500, not a 400.** Panicking (or letting a Rust guest
`unwrap` on bad input) produces a server error for your API caller. If a
condition is a business rejection, return `ok:false` with a `reject` — do not
trap.

⚠ **You cannot catch fuel exhaustion.** The trap unwinds the guest
immediately; there is no chance to write a partial response. Any `host_mutate`
already committed **stays committed** on the stateless path — the writes are
not wrapped in one transaction. Design mutations to be idempotent, or do the
work in one `host_mutate` call.

⚠ **A `wasm_timeout` does not mean "no writes happened".** The 5 s wall clock
bounds the caller's wait; it does not stop the module, which keeps running on
its worker until fuel or the host-call cap stops it. A `host_mutate` issued in
that window can still commit after the caller received the timeout. Treat a
timed-out invocation as "outcome unknown" and make retries idempotent.

**Every invocation is logged.** A row lands in the platform's operator-
invocation log with latency, success, error kind, error message and fuel
consumed.
Logging is best-effort and never fails the call. Fuel consumed is recorded on
success and on a business rejection, but is `NULL` when the engine itself
failed.

---

## 10. Uploading and activating

Three endpoints, all requiring **Manager** on the app.

### `POST /app/wasm/upload` — multipart

| Field | Required | Notes |
|---|---|---|
| `app_tid` | yes | |
| `op_id` | yes | ≤48 chars, ASCII alphanumeric plus `.` `_` `-` |
| `version` | yes | same character rule; your own label (semver, git SHA, anything) |
| `file` | yes | the `.wasm` bytes. **The field name must be exactly `file`** |
| `public` | no | `true`/`1`/`yes` opts into unauthenticated dispatch **with no data bridge** |
| `min_license` | no | defaults to `demo` |
| `notes` | no | free text |

⚠ **Keep the whole upload request under 2 MiB.** A larger request is refused
while its body is read — 400 `bad_request` with the message
`Error parsing multipart/form-data request`, or the connection is closed for a
much larger one. This happens before the server's own 10 MiB module check, so
that figure is not reachable today and an oversized module never gets the
`file_too_large` code. Strip debug sections and optimise for size
(e.g. `wasm-opt -Oz --strip-debug`) before uploading.

Both `op_id` and `version` are validated by the **same** function, which
accepts non-empty strings up to 48 characters of ASCII alphanumerics, `.`, `_`
and `-`. The API's rejection message for `op_id` says "kebab-case"; the
implementation does not require kebab-case and does not reject uppercase.
Prefer lower-case kebab anyway — it is the URL segment.

The server validates the module loads and exports the ABI surface **before**
storing anything, and stores it
**inactive**.

Uploads are **immutable per `(op_id, version)`** — re-uploading the same pair
is rejected with `wasm_version_exists`. Ship a new version label instead.

The response echoes the module's `sha256` and `total_bytes`; verify the digest
against your build artifact if you need supply-chain assurance.

### `POST /app/wasm/activate` — `{app_tid, op_id, version}`

Flips the single active version for `(app_tid, op_id)`. Serialized by an
advisory lock so concurrent activations cannot race. Rollback is the same call with an
earlier version label.

### `POST /app/wasm/list` — `{app_tid}`

Returns every uploaded version with `op_id`, `version`, `sha256`,
`min_license`, `total_bytes`, `active`, `public`, `uploaded_by`,
`uploaded_at`.

### License tier

Each version declares a `min_license`. Activation refuses a version whose tier
outranks the app's, and **HTTP dispatch re-checks it on every
invocation**, so a later downgrade stops an over-tier operator.

⚠ **The lifecycle-hook path is not tier-gated.** Only HTTP dispatch re-checks.
A downgraded app keeps running its operator as a doc hook — deliberately,
since blocking authorized doc writes on a billing state is the wrong failure
mode. Do not treat the tier gate as a security control; it is a commercial one.

---

## 11. Gotchas

1. **An `op_id` that collides with a catalog operator is silently shadowed.**
   Your module never runs and nothing tells you (§1a).
2. **A `wasm` hook naming an operator with no active version is inert.** The
   write proceeds as if the hook were not there. A typo in `params.op_id` is
   invisible to the caller (§1b).
3. **A clean upload does not mean a working ABI.** Export *names* are checked;
   signatures are not. Invoke once before believing it (§3).
4. **`host_call` returning `-1` / `-2` is not "no data".** Handle both (§6).
5. **An empty `host_query` result is not "no rows exist".** It is also what
   ACL denial looks like (§7).
6. **You will not see the fence while testing as the app owner.** Owner, app
   manager and resource author bypass gate 2 entirely. Test every operator as
   a *restricted* user before shipping it, or you will ship logic that only
   works for admins.
7. **`host_mutate` `update` replaces the document's data wholesale.** It is
   not a patch (§8).
8. **Hooks do not fire for bridge writes**, so hook-maintained invariants do
   not hold for docs your module creates (§8).
9. **Traps become 500s.** Business rejections must be `ok:false`, not a
   panic (§9).
10. **`host_mutate` writes are not rolled back if the invocation later traps**
    (§9).
11. **`data` and `body` are never both populated.** Write your `tfl5_invoke` to
    branch on `action`, and treat a null where you expected an object as a
    programming error in your hook wiring rather than something to paper over.
12. **`now_ms` is your only clock, and it is set by the host at dispatch
    time.** Do not derive elapsed time inside one invocation from it; it does
    not advance.
