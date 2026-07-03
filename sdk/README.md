# `@tfl5/sdk`

Official JS/TS client for the **tfl5** platform. Wraps the fixed REST
contract — you don't hand-roll `fetch`, envelopes, or error parsing.

> Status: **0.1.0.** Core transport + auth + the full client surface are
> implemented, typecheck clean, and e2e-smoked against a real dev server.
> Served by the platform at `GET /sdk.js` / `GET /sdk.mjs` (below); not yet
> published to npm. See `docs/sdk.md` for the design spec this realizes and
> `docs/api-reference.md` for the full REST contract.

## Architecture → SDK map

The platform spine is immutable: **`apps` → (`groups`, `roles`,
`resources`, `docs`)**. Everything else composes from it. The SDK mirrors
that shape one-to-one:

| Platform primitive | Endpoints | SDK surface |
|---|---|---|
| `apps` (spine root) + 7-array ACL + members | `/app/update` `/app/get` `/app/list` `/app/acl-set` `/app/member/*` | `tfl5.apps` |
| `roles` (per-app) | `/app/role/*` `/app/roles/list` | `tfl5.roles` |
| `groups` (global) | `/admin/group/*` | `tfl5.groups` |
| `resources` + `docs` | `/app/resource/*` `/app/doc/*` | `tfl5.resource(ma)` |
| declarative hooks | `resources.hooks` | `tfl5.resource(ma).hooks` |
| field-level encryption (lvl 0/1/2) | transparent (server splits `data_indexed`/`data_secret`) | — (you read/write plain fields) |
| operators (catalog + WASM) | `/op/<id>/<action>` | `tfl5.operator(id).invoke()` |
| operator admin / config | `/app/integrations/*` | `tfl5.integrations` |
| tenant WASM lifecycle | `/app/wasm/*` | `tfl5.wasm` |
| files + folders | `/app/file/*` `/app/folder/*` | `tfl5.files` |
| per-doc shares + link claim | `/app/share/*` | `tfl5.shares` |
| signed sources | `/app/source/*` | `tfl5.sources` |
| auth (cookie + bearer) | `/login` `/logout` `/reg` `/user` `/auth/*` | `tfl5.auth` |
| PDPD data-subject rights | `/user/data/export` `/user/data/erase` `/user/data/erase/cancel` | `tfl5.auth` (`exportData` / `eraseAccount` / `cancelErase`) |

Anything not yet covered by a typed client: `tfl5.raw(path, body)`.

## Auth modes

- **cookie** (browser SPA) — `/login` sets the `_token` cookie; the SDK
  sends `credentials: "include"`. Default when a `window` exists.
- **bearer** (Node/CLI) — `/login` or a minted service token returns a
  `token` the SDK captures and sends as `Authorization: Bearer`. Default
  in Node.

## Quick start

```ts
import { TFL5 } from "@tfl5/sdk";

const tfl5 = new TFL5({ host: "https://acme.example.com" }); // bearer in Node
await tfl5.auth.login("dev_demo", "demo_pass_123");          // captures token
tfl5.useApp("a-xxxx");                                        // scope app_tid

// Docs
const task = tfl5.resource<{ title: string; status: string }>("task");
const created = await task.create({ title: "Write SDK", status: "todo" });
const open = await task.list({ where: { status: "todo" }, limit: 50 });
await task.update(created.tid, { status: "done" });

// Operators (catalog)
const qr = await tfl5.operator("vietqr").invoke("generate", { amount: 50000 });

// WASM operator — your own sandboxed server-side code (ACL-scoped to the
// caller; limits in docs/api-reference.md §Operators). Manager-gated lifecycle:
await tfl5.wasm.upload({ op_id: "price-engine", version: "1.0.0", bytecode: wasmBytes });
await tfl5.wasm.activate("price-engine", "1.0.0");
const quote = await tfl5.operator("price-engine").invoke("quote", { items });

// Signed sources — register an inbound data channel (Manager-gated).
// The secret is returned ONCE; store it securely before discarding the response.
// Hand `ingest_url` to the external system; it signs pushes with HMAC-SHA256.
// Full push-side protocol: docs/api-reference.md §Signed sources.
const src = await tfl5.sources.register({ name: "stripe-events", target_resource_ma: "order" });
console.log(src.ingest_url, src.secret); // secret shown once!
const all = await tfl5.sources.list();   // secret omitted
const rotated = await tfl5.sources.rotate(src.tid); // new secret, old invalidated
await tfl5.sources.revoke(src.tid);

// Files (multipart, never base64)
await tfl5.files.upload({ path: "/avatars", file: someBlob, filename: "a.png" });
```

## Errors

Every rejection is a `Tfl5Error` subclass keyed on the server's stable
`code` (never the localized `msg`):

```ts
import { AccessDeniedError, NotFoundError, RateLimitError } from "@tfl5/sdk";

try {
  await tfl5.resource("task").get("nope");
} catch (e) {
  if (e instanceof NotFoundError) { /* ... */ }
  if (e instanceof AccessDeniedError) { /* ... */ }
  if (e instanceof RateLimitError) { await sleep((e.retryAfter ?? 1) * 1000); }
}
```

## Install

ESM-only package (Node ≥ 18, any bundler, or native browser modules):

```bash
npm install @tfl5/sdk
```

```ts
import { TFL5 } from "@tfl5/sdk";
const tfl5 = new TFL5({ host: "https://your-app.example.com" });
```

## No-build / `<script>` usage — served by the platform

Every tfl5 server serves the browser build of this SDK directly, so a page
can use it with no npm step:

```html
<!-- classic script: defines window.TFL5 -->
<script src="/sdk.js"></script>
<script>
  const tfl5 = new TFL5();           // host defaults to window.location.origin
</script>

<!-- or ESM -->
<script type="module">
  import { TFL5 } from "/sdk.mjs";
  const tfl5 = new TFL5();
</script>
```

Both bundles are baked into the server binary, so `/sdk.js` always matches
the SDK source the running server was built from.

## Build

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # emits dist/ (ESM + .d.ts) — the npm package
npm run build:browser # emits dist/browser/sdk.{js,mjs} — standalone
                      # browser bundles (IIFE + ESM) for <script> usage
```

## Publish

ESM-only; ships `dist/` + `README.md`. Before `npm publish`: bump `version`,
`npm run build`, confirm `npm pack --dry-run` lists only `dist` + README. The
`/sdk.js` server route is independent of npm publish (it reads the committed
browser bundle) — re-run `npm run build:browser` + redeploy to update it.

## End-to-end smoke test

`smoke/smoke.mjs` drives the whole client surface against a **real** dev
server (register → login → app → resource with a level-2 secret field →
doc CRUD → list/where → a `set_fields` hook stamping a secret field → shares
→ error mapping). It needs a running dev server (a local tfl5 server on :8090) and the dev Postgres container reachable
(one fixture marks the smoke user's email verified — data writes are gated
on it).

```bash
sdk/smoke/run.sh                      # host=http://localhost:8090, pg=tfl5_pg
TFL5_SMOKE_HOST=… PG_CONTAINER=… sdk/smoke/run.sh
```

> The smoke run is what verified the request/response contract end-to-end:
> it caught `update` being a full-replace (not a partial patch),
> `shares.create` requiring `target`, and a `where` on an encrypted field
> being rejected (not silently empty). Node cookie-mode uses an in-memory
> cookie jar so `/login`'s `_token` persists across calls.
