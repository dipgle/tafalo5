# Data: resources, docs, hooks, import, sharing

All examples assume `tfl5.useApp(appTid)` has been called.

## Resources and fields

A **resource** is a typed collection inside an app; its records are **docs**.
You address a resource by its machine alias `ma`.

```ts
import { FieldLevel } from "@tfl5/sdk";

await tfl5.resources.create({
  ma: "patient",
  name: "Patient",
  fields: [
    { field: "name", validator: "required" },
    { field: "ward" },
    { field: "national_id", level: FieldLevel.TopSecret },
  ],
});

const list = await tfl5.resources.list();            // [{ tid, ma, name, … }]
const def = await tfl5.resource("patient").getSchema();
await tfl5.resource("patient").putSchema({ fields: [...def.fields!, { field: "bed" }] });
```

**Field levels.** `0` (default) is stored in plain text and can be filtered on.
`1` (`Sensitive`) and `2` (`TopSecret`) are encrypted at rest. You always read
and write plain values; the server encrypts and decrypts for you. A `where`
filter on a level-1/2 field is refused (`BadRequestError`).

**Resource ACL.** A resource has its own `readers`, `editors`, `noaccess` and
`deletable` arrays. Give them to `tfl5.resources.create()` or change them later
with `tfl5.resource(ma).setResourceAcl({ readers: [...] })` (arrays you omit
are kept). Leave them empty and only the app's ACL applies.

**Deleting a resource.** `tfl5.resource(ma).destroy()` (Manager) deletes the
definition and drops its docs. It is refused with
`resource_referenced_by_link` while another resource links to it.
`tfl5.resources.constraints()` reports per-resource counts and flags, and
lists `orphans` (deleted resources whose storage still has rows), which
`tfl5.resources.dropOrphan(tid)` cleans up.

## Docs

```ts
type Patient = { name: string; ward?: string; national_id?: string };
const patients = tfl5.resource<Patient>("patient");

const { tid } = await patients.create({ name: "An", ward: "A1", national_id: "0791…" });
const doc = await patients.get(tid);                 // doc.data.national_id is decrypted
await patients.patch(tid, { ward: "B2" });           // get + merge + update
await patients.update(tid, { name: "An", ward: "B2" }); // REPLACES data: national_id is gone
await patients.del(tid);                             // soft delete
```

- `update()` replaces the whole `data` object. `patch()` is a convenience that
  reads, merges and writes; it is not atomic against a concurrent writer.
- `upsert({ match_on, data })` updates the single doc whose level-0 fields
  contain `match_on`, or inserts one. It is refused if more than one doc
  matches. On a match, `data` replaces the doc's data.
- `createBatch(items, { atomic })` writes up to 200 docs in one call.

### Queries and paging

`where` is an AND of equality tests on level-0 fields; an array value means
"any of" (IN):

```ts
const open = await patients.list({ where: { ward: ["A1", "A2"] }, limit: 50 });
```

Results come newest first. For more than a few pages use the keyset cursor —
`offset` is capped (`offset_too_deep`):

```ts
let cursor: string | undefined;
do {
  const page = await patients.listPage({ limit: 100, cursor });
  handle(page.docs);
  cursor = page.nextCursor;
} while (cursor);
```

Other `list` options: `author` (only docs created by one user) and
`include_deleted`.

## Access control

Who can do what is decided in layers. Each layer uses the same ACL arrays —
`managers`, `designers`, `editors`, `readers`, `deletable`, `noaccess` — whose
entries are user ids (`u-…`), group ids (`g-…`), role tokens (`[r-…]`) or
`G_author` (any signed-in user).

| STT | Layer | Set with | Governs |
|---|---|---|---|
| 1 | App | `tfl5.apps.setAcl(appTid, { … })` | everything in the app; the owner always passes |
| 2 | Resource | `tfl5.resources.create({ …, readers })` or `resource(ma).setResourceAcl({ … })` | reads and writes of that resource's docs |
| 3 | Scope bindings | `tfl5.access.scopeSet(...)` | row filtering by attributes (e.g. school, ward) |
| 4 | Doc | `resource(ma).setAcl(tid, { … })` | updating and deleting that doc, and sharing |

Levels, lowest to highest: Reader → Editor → Designer → Manager → Owner.

> **Reading is decided by layers 1–3.** A doc's own `readers` / `noaccess`
> arrays govern writes, not reads: a user who may read the resource can read
> every doc in it. To keep some records from some users, put them in a
> separate resource with its own `readers`, or use scope bindings.

Roles are per app: `tfl5.roles.create({ name })`, then put `[r-<tid>]` into
ACL arrays and add members with `tfl5.apps.setMemberRoles(userTid, [roleTid])`.
Groups (`tfl5.groups`) are platform-wide and managed by the platform operator.

## Hooks

Hooks are stored on the resource definition and run on doc events. Event
names are `before_create`, `after_create`, `before_update`, `after_update`,
`before_del`, `after_del`. The server does not reject unknown names — a hook
with a misspelled event is stored and never fires.

```ts
await tfl5.resource("order").hooks.set([
  // refuse a create/delete unless a field is present (code hook_validation_failed)
  { id: "need_total", on: ["before_create"], type: "require_fields", params: { fields: ["total"] } },
  // stamp fields after a create (secret fields stay encrypted)
  { id: "stamp", on: ["after_create"], type: "set_fields", params: { set: { status: "new" } } },
  // POST the doc to your endpoint in the background
  { id: "notify", on: ["after_create"], type: "webhook", params: { url: "https://example.com/hook" } },
  // call your WASM operator (action defaults to the event name)
  { id: "price", on: ["after_update"], type: "wasm", params: { op_id: "pricing" } },
]);
```

`hooks.set()` replaces the whole list.

### Code guards

For logic that does not fit a declarative hook, a resource can carry small
JavaScript guards (`before_create_code`, `after_create_code`,
`before_update_code`, `after_update_code`) set with `putSchema()`. They run in
a sandbox (about 100 ms, no network or file access) and see a global `ctx`:
`ctx.data` (the record; changes in `before_*` are kept), `ctx.doc` /
`ctx.old_doc`, `ctx.user`, `ctx.now_ms`, and `ctx.reject(msg, code?)` to
refuse the write. Pass `""` to remove a guard.

## Import from CSV or Excel

```ts
const file = input.files[0];                                  // .csv or .xlsx, ≤ 20 MiB
const preview = await tfl5.resources.previewImport(file);     // infer fields; writes nothing
await tfl5.resources.create({ ma: "contact", name: "Contact", fields: preview.fields });
const res = await tfl5.resource("contact").importFile({ file, mapping: preview.mapping });
// res = { tids, count, requested, failures? }  — failures carry the 1-based file row
```

Up to 5000 rows per file. Rows go through the same validators and hooks as
`create()`. With `atomic: true` each block of 200 rows is all-or-nothing.

## Sharing a doc

```ts
const grant = await tfl5.shares.create({ doc_tid: tid, target: "anonymous", fields: ["name"] });
const url = `https://your-app.example.com/share#${grant.token}`;

// on the receiving page, with no sign-in:
const shared = await tfl5.shares.claim(token, appTid);   // { doc_tid, data, … }
```

`target` can also be a user id, a group id, a role token or `G_author`. A link
returns only level-0 fields (narrowed to `fields` when given); encrypted fields
are never exposed through a link. `tfl5.shares.revoke(grantTid)` disables it.

## Signed data sources

A source is an inbound channel an external system can push docs into with an
HMAC signature:

```ts
const src = await tfl5.sources.register({ name: "shop-orders", target_resource_ma: "order" });
// src.ingest_url and src.secret — the secret is shown once
await tfl5.sources.rotate(src.tid);   // new secret, the old one stops working
await tfl5.sources.revoke(src.tid);
```

## Audit log and data rights

- `tfl5.audit.list()` — the app's control-plane audit log (Manager).
- `tfl5.auth.exportData()` — everything the platform holds about the signed-in
  user; `tfl5.auth.eraseAccount({ password })` schedules erasure after a grace
  period (`cancelErase()` withdraws it).
