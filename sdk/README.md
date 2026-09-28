# Tafalo SDK (`@tfl5/sdk`)

JavaScript/TypeScript client for **Tafalo** (codename **tfl5**), a multi-tenant
platform for building apps without running your own backend. The SDK wraps the
platform's REST and WebSocket API so you don't hand-roll `fetch` calls,
response envelopes or error parsing.

- Works in the browser and in Node 18+ (ESM, no runtime dependencies).
- Fully typed; every method maps to one documented endpoint.
- Also served by every Tafalo server at `/sdk.js` and `/sdk.mjs`, so a page can
  use it with no build step.

```ts
import { TFL5 } from "@tfl5/sdk";

const tfl5 = new TFL5({ host: "https://your-app.example.com" });
await tfl5.auth.login("alice", "correct horse battery staple");
tfl5.useApp("a-1234…");                           // scope calls to one app

const tasks = tfl5.resource<{ title: string; done: boolean }>("task");
const t = await tasks.create({ title: "Write docs", done: false });
await tasks.patch(t.tid, { done: true });          // merge; update() replaces
const open = await tasks.list({ where: { done: false }, limit: 50 });
```

## How the platform is shaped

Everything an app stores is built from five entities. The SDK mirrors them:

| STT | Entity | What it is | SDK |
|---|---|---|---|
| 1 | app | a tenant: its members, roles, ACL, domains, front-end | `tfl5.apps`, `tfl5.useApp()` |
| 2 | group | a set of users, usable in ACLs | `tfl5.groups` |
| 3 | role | a per-app label granted to members, usable in ACLs | `tfl5.roles` |
| 4 | resource | a typed collection (like a table) with fields and hooks | `tfl5.resources`, `tfl5.resource(ma).getSchema()` |
| 5 | doc | one record of a resource | `tfl5.resource(ma)` |

Access is decided by ACL arrays on apps, resources, docs and files —
`managers`, `designers`, `editors`, `readers`, `deletable`, `noaccess` —
holding user ids (`u-…`), group ids (`g-…`) and role tokens (`[r-…]`; send a
raw `r-…` and the server adds the brackets). Fields can be encrypted at rest
one by one (level 1 or 2); the SDK always reads and writes plain values.

## Install

The package is not on npm yet. Build it from source (this folder), then add
it to your project by path:

```bash
npm install && npm run build            # in this folder → dist/
npm install /path/to/this/folder        # in your project
```

Or load the copy your Tafalo server serves, with no build step:

```html
<!-- classic script: defines window.TFL5 -->
<script src="/sdk.js"></script>
<script>
  const tfl5 = new TFL5();          // host defaults to the page's origin
</script>

<!-- or as a module -->
<script type="module">
  import { TFL5 } from "/sdk.mjs";
</script>
```

The served copy is built into the server binary, so it matches the API of the
server that serves it — but it is only as new as that server. A server that
has not been updated since 0.2.0 serves a copy in which **every call fails in
the browser** with `TypeError: Illegal invocation`. If you see that, load a
build of this SDK instead (`npm run bundle` → `dist/browser/sdk.js` and
`dist/browser/sdk.mjs`).

## Signing in

- **Browser (same origin):** `await tfl5.auth.login(user, pass)` sets the
  session cookie; nothing else to do.
- **Node:** the same call works — the SDK keeps the session cookie in memory.
- **Server-to-server:** pass a service token (`st_…`) issued by the platform
  operator: `new TFL5({ host, token: "st_…" })` (bearer mode).

Google, Microsoft, magic link, phone OTP, QR-code, Telegram and VNeID sign-in
are covered in [docs/authentication.md](docs/authentication.md).

## Errors

Every failure is thrown as a `Tfl5Error` subclass. Branch on `err.code` (a
stable machine code), never on the message text:

```ts
import { NotFoundError, AccessDeniedError, RateLimitError } from "@tfl5/sdk";

try {
  await tfl5.resource("task").get("d-missing");
} catch (e) {
  if (e instanceof NotFoundError) { /* … */ }
  else if (e instanceof RateLimitError) await sleep((e.retryAfter ?? 1) * 1000);
  else if (e.code === "hook_validation_failed") { /* a hook refused the write */ }
  else throw e;
}
```

See [docs/errors.md](docs/errors.md).

## Documentation

| STT | Guide | Covers |
|---|---|---|
| 1 | [Getting started](docs/getting-started.md) | first app, resource and docs, from zero |
| 2 | [Authentication](docs/authentication.md) | every sign-in method, sessions, service tokens |
| 3 | [Data](docs/data.md) | resources, fields and encryption, docs, queries, paging, hooks, CSV/XLSX import, sharing |
| 4 | [Files and sites](docs/files-and-sites.md) | file storage and stages, site publishing, bundles, encrypted attachments |
| 5 | [Realtime](docs/realtime.md) | durable operator instances, live projections, chat |
| 6 | [Billing](docs/billing.md) | catalog, checkout, credits, invoices, entitlement tokens |
| 7 | [Errors](docs/errors.md) | error classes and codes |
| 8 | [API reference](docs/reference.md) | every method, generated from the source |

## Development

```bash
npm install
npm run typecheck
npm test                 # unit tests (no server needed)
npm run docs:check       # docs/reference.md matches src/
TFL5_SMOKE_HOST=http://localhost:8090 npm run smoke   # end-to-end, needs a server
```

The end-to-end smoke registers two users against a running server and drives
every client through real requests (see the header of `smoke/smoke.mjs`).

## License

[MIT](LICENSE)
