# JS/TS SDK — `@tfl5/sdk`

> **Status: 0.1.0 — implemented, not yet published to npm.** Core transport,
> auth, and the full client surface documented below are real, typecheck
> clean, and end-to-end smoked against a live dev server (see
> `sdk/README.md` for the smoke-test notes). This file is the API
> reference for what ships today, plus a look at what's landing next.
> Every endpoint here also has a plain-REST description in
> [api-reference.md](api-reference.md) if you'd rather call it directly
> without the SDK.

---

## 1. Distribution

| Form | Use case | What you get |
|---|---|---|
| `GET /sdk.js` | Drop-in `<script>` tag, zero build step | IIFE bundle, registers `window.TFL5` |
| `GET /sdk.mjs` | Native ESM `<script type="module">` | `import { TFL5 } from "/sdk.mjs"` |
| `GET /sdk-ui.js` / `GET /sdk-ui.mjs` | The opt-in Google Sign-In button helper | registers `window.tfl5ui`, or `import { mountGoogleButton }` |
| `npm install @tfl5/sdk` | Node/CLI or a bundler pipeline (Vite/webpack/Next.js) | ESM + `.d.ts` — **not published yet**; build from `sdk/` in this repo meanwhile |

Every tfl5 server serves its own SDK bundle: `/sdk.js`, `/sdk.mjs`,
`/sdk-ui.js`, `/sdk-ui.mjs` are baked into the server binary from the
committed `sdk/` source, so the bundle a server serves always matches the
version it was built from — there's no drift between "the SDK docs" and
"what `<script src="/sdk.js">` actually gives you." There is no separate
`@tfl5/cli` codegen tool today.

## 2. Browser usage (no build step)

```html
<script src="/sdk.js"></script>
<script>
(async () => {
  const tfl5 = new TFL5();                 // host = window.location.origin
  await tfl5.auth.login(username, password);
  tfl5.useApp("a-xxxx");
})();
</script>
```

or ESM:

```html
<script type="module">
  import { TFL5 } from "/sdk.mjs";
  const tfl5 = new TFL5();
</script>
```

`host` defaults to `window.location.origin` in the browser. There is no
auto-detected `appId` — call `tfl5.useApp(appTid)` once you know it (or
pass `app_tid` per-call; an explicit body value always wins over the
scoped app).

## 3. Node / server-side usage

```ts
import { TFL5 } from "@tfl5/sdk";

const tfl5 = new TFL5({
  host: "https://acme.example.com",
  appId: "a_xxx", // no `window` in Node, so set it explicitly
});

await tfl5.auth.login("dev_demo", process.env.DEMO_PASSWORD!); // captures the bearer token
const me = await tfl5.auth.me();
```

Node mode defaults to `auth: "bearer"` (no `window` present) and sends
`Authorization: Bearer <token>`. You can also mint/pass a token directly:

```ts
const tfl5 = new TFL5({ host: "...", appId: "a_xxx", token: myServiceToken });
```

## 4. Architecture → SDK map

The platform spine is immutable: **`apps` → (`groups`, `roles`,
`resources`, `docs`)**. The SDK mirrors that shape one-to-one, plus the
surrounding primitives:

| Platform primitive | Endpoints | SDK surface |
|---|---|---|
| `apps` (spine root) + 7-array ACL + members | `/app/update` `/app/get` `/app/list` `/app/acl-set` `/app/member/*` | `tfl5.apps` |
| `roles` (per-app) | `/app/role/*` `/app/roles/list` | `tfl5.roles` |
| `groups` (global) | `/admin/group/*` | `tfl5.groups` |
| `resources` + `docs` | `/app/resource/*` `/app/doc/*` | `tfl5.resource(ma)` |
| declarative hooks | `resources.hooks` | `tfl5.resource(ma).hooks` |
| field-level encryption (level 0/1/2) | transparent — server splits `data_indexed`/`data_secret` | — you always read/write plain field values |
| row-level scope | `/app/scope/*` | `tfl5.scope` |
| operators (catalog + WASM) | `/op/<id>/<action>` | `tfl5.operator(id).invoke()` |
| operator admin/config | `/app/integrations/*` | `tfl5.integrations` |
| tenant WASM lifecycle | `/app/wasm/*` | `tfl5.wasm` |
| app-wide files + folders | `/app/file/*` `/app/folder/*` | `tfl5.files` |
| per-doc shares + link claim | `/app/share/*` | `tfl5.shares` |
| signed inbound data channels | `/app/source/*` | `tfl5.sources` |
| auth (cookie + bearer) + PDPD rights | `/login` `/logout` `/reg` `/user` `/auth/*` `/user/data/*` | `tfl5.auth` |

Anything not yet covered by a typed client: `tfl5.raw(path, body)` — a
raw POST that still unwraps the `{result, data}` envelope and throws the
same typed errors.

### 4.1 Landing next (endpoint groups without a typed client yet)

These endpoint groups are real and callable today via `tfl5.raw(...)` or
plain `fetch`; typed SDK modules for them are being built out. Treat the
names below as the REST surface they wrap, not as a preview of exact SDK
method signatures — those may still shift before each module ships:

| Area | Endpoints | What it's for |
|---|---|---|
| Site publishing | `/app/site/*` | The content-addressed draft → snapshot → publish/rollback engine behind the visual no-code builder and the in-browser code editor. See [app-builder-guide.md §2.1/§4](app-builder-guide.md#21-serving-precedence--read-this-before-you-upload-anything). |
| Versioned code deploy | `/app/bundle/*` | Upload + activate a versioned FE build, with rollback. |
| Per-doc encrypted attachments | `/app/f3/*` | Files bound to one doc's ACL and encryption key (distinct from the app-wide `tfl5.files`). |
| Durable compute | `/durable/*`, `/ws/durable/subscribe` | The opt-in, **default-OFF** stateful/durable-execution operator — see [app-builder-guide.md §7](app-builder-guide.md#7-what-tfl5-does-not-give-you). |
| Per-app email | `/app/email/*` | Send via the platform's mail service, list sends/inbox, DKIM + DNS record setup. |
| Billing | `/billing/*` | The public pricing catalog, checkout, and provider webhooks. |
| Account | `/user/*` (profile, 2FA, email management) | Broader account management alongside the PDPD rights already in `tfl5.auth` today. |
| Realtime chat | `/ws/chat`, `/app/chat/history` | The first-party, Reader-gated, room-scoped WebSocket chat primitive. |

## 5. Docs & resources — `tfl5.resource(ma)`

```ts
const task = tfl5.resource<{ title: string; status: string }>("task");

const created = await task.create({ title: "Write SDK docs", status: "todo" });
const open = await task.list({ where: { status: "todo" }, limit: 50 });
await task.update(created.tid, { ...created.data, status: "done" }); // full replace
await task.patch(created.tid, { status: "done" });                  // get → merge → update
await task.upsert({ match_on: { title: "Write SDK docs" }, data: created.data });
await task.setAcl(created.tid, { readers: ["[r_team]"] });
await task.del(created.tid);
```

`update()` **replaces** `data` wholesale — any field you don't send is
dropped server-side. `patch()` is a convenience read-modify-write (not
atomic — a concurrent writer can race it); for an ACL-only change use
`setAcl()` instead of touching `data`.

Schema + hooks live on the same client (resolved by `ma`, cached):

```ts
const schema = await task.getSchema();               // fields, hooks, ...
await task.putSchema({ hooks: [...] });               // replace hooks (or fields/ACL)
await task.hooks.set([{ id: "require_status", on: ["before_create"],
  type: "require_fields", params: { fields: ["status"] } }]);

// Create a NEW resource on the currently-scoped app:
await tfl5.createResource({ ma: "task", name: "Task", fields: [...] });
```

Field-level encryption (level 0/1/2) is transparent end to end,
including through `set_fields` hooks — the SDK only ever sees plaintext
field values; see [app-builder-guide.md §5.1](app-builder-guide.md#51-fields-jsonb-array)
for what each level means.

## 6. Auth — `tfl5.auth`

```ts
await tfl5.auth.login(username, password);   // captures the bearer token in Node mode
await tfl5.auth.register({ username, password, re_password, email });
const me = await tfl5.auth.me();             // throws UnauthorizedError if not signed in
await tfl5.auth.logout();
```

Alternative sign-in methods all converge on the same session:

```ts
await tfl5.auth.magicLink(email);                       // sends the email; always success-shaped
await tfl5.auth.phoneStart(phone);                       // Zalo ZNS OTP
const session = await tfl5.auth.phoneVerify(phone, otp);
const { qr_id } = await tfl5.auth.qrStart();              // desktop shows a QR
const session2 = await tfl5.auth.qrPoll(qr_id!);          // ...mobile approves it
```

Google Sign-In needs Google's own script to render the button and run
consent, so it's a separate opt-in bundle rather than part of headless
`tfl5.auth`:

```ts
import { mountGoogleButton } from "@tfl5/sdk/ui"; // or /sdk-ui.mjs when served

await mountGoogleButton(tfl5, {
  target: "#google-btn",
  onSignIn: (session) => { location.href = "/app"; },
  // Only invoked if the email matches an existing UNVERIFIED account,
  // which needs its password to prove ownership before linking:
  onRequiresPassword: (usernameHint) => promptForPassword(usernameHint),
});
```

`mountGoogleButton` auto-fetches `google_client_id` from `GET
/platform/info` unless you pass `clientId`, and throws if the operator
hasn't set `TFL5_GOOGLE_CLIENT_ID`. Calling `tfl5.auth.google(credential)`
directly is the lower-level equivalent if you render the button yourself.

Telegram and VNeID sign-in are real platform endpoints
(`/auth/telegram/*`, `/auth/vneid/*`) that `tfl5.auth` doesn't wrap yet —
reach them with `tfl5.raw(path, body)` in the meantime.

### 6.1 PDPD data-subject rights (NĐ 13/2023)

Self-scoped only — there is no admin-override form; these act on the
caller's own account.

```ts
const dump = await tfl5.auth.exportData();     // profile + email metadata + app memberships
// document/file content inside each app is exported via that app's own
// /app/doc/* and /app/file/* APIs, not by exportData().

try {
  const r = await tfl5.auth.eraseAccount({ password });
  // Success: signed out everywhere; hard-erase runs after a grace window
  // (default 24h) unless you call cancelErase() before it elapses.
} catch (e) {
  if (e instanceof Tfl5Error && e.code === "owns_apps") {
    console.warn("Transfer or delete these apps first:", e.body.app_tids);
  } else throw e; // password_required / totp_required / other
}

await tfl5.auth.cancelErase(); // throws code:"no_pending_erasure" if nothing's pending
```

## 7. Operators — `tfl5.operator(id)`, `tfl5.integrations`, `tfl5.wasm`

```ts
// Catalog operator (e.g. VietQR):
const qr = await tfl5.operator("vietqr").invoke("generate", { amount: 50000 });

// Per-app operator config (credentials, on/off):
await tfl5.integrations.enable("zalo-zns");
await tfl5.integrations.setConfig("zalo-zns", { oa_id, access_token, templates: {...} });

// Your own server-side code, sandboxed:
await tfl5.wasm.upload({ op_id: "price-engine", version: "1.0.0", bytecode: wasmBytes });
await tfl5.wasm.activate("price-engine", "1.0.0");
const quote = await tfl5.operator("price-engine").invoke("quote", { items });
```

WASM is tfl5's one sandboxed server-side code lane (no JS/Lua `eval`): a
module runs fuel/memory/time-bounded and reaches data through host calls
that execute **as the calling user** — it can never exceed the caller's
ACL. Full limits and the guest ABI: api-reference.md §Operators →
"WASM operators".

Catalog operators that call out to a real external service (email, Zalo
ZNS, Viettel SMS, VietQR, VNeID, payment) only work once the app has
configured its own credentials via `tfl5.integrations.setConfig(...)` —
see [app-builder-guide.md §7](app-builder-guide.md#7-what-tfl5-does-not-give-you)
for exactly what each one needs.

## 8. Files — `tfl5.files`

```ts
await tfl5.files.upload({ path: "/avatars", file: someBlob, filename: "a.png" });
const list = await tfl5.files.list("/avatars");
const { signed_url } = await tfl5.files.signUrl("/avatars/a.png", { expires_in_sec: 300 });
await tfl5.files.rename(fileId, "new-name.png");
await tfl5.files.del(fileId);      // soft-delete → trash
await tfl5.files.restore(fileId);  // undo, while still in trash
await tfl5.files.createFolder("/avatars/thumbs");
```

Uploads are multipart only — never base64-in-JSON. `signUrl` mints a
short-lived link (default 5 min, server-capped at 1 hour); mint it
on-demand at view time rather than persisting it. This client wraps the
app-wide `/app/file/*` tier described in
[app-builder-guide.md §3](app-builder-guide.md#3-building-blocks--when-to-use-what) —
for your app's *published site* specifically (with draft/publish/rollback
semantics), see the site engine in §4.1 above.

## 9. Shares — `tfl5.shares`

```ts
const share = await tfl5.shares.create({
  doc_tid: "d_xxx",
  target: "anonymous",              // or a user_tid / "[r_role]" / "G_group"
  fields: ["full_name", "diagnosis_code"],
  expires_at: Date.now() + 86_400_000,
});
// share.token is only returned for target:"anonymous" — that's the link token

const claimed = await tfl5.shares.claim(token); // exchange a token for the projected doc
await tfl5.shares.revoke(share.tid);
```

## 10. Roles + groups — `tfl5.roles`, `tfl5.groups`

```ts
const role = await tfl5.roles.create({ name: "homeroom_7a", members: [userTid] });
await tfl5.roles.edit(role.tid, { members: [...role.members!, otherUserTid] }); // members REPLACES
await tfl5.roles.del(role.tid);

const group = await tfl5.groups.create({ name: "district-1-schools" }); // global, admin-scoped
```

## 11. Scope — `tfl5.scope`

Row-level scope is the 4th authorization layer: it fences rows by a data
field (own / class / company / …), on top of the ACL arrays. It's
designer-configured and env + per-app opt-in — see
[scope.md](scope.md) for the full model.

```ts
const cfg = await tfl5.scope.get();          // field_map + the CALLER's own bindings only
await tfl5.scope.setFieldMap({ student: { O: "created_by_user_tid" } });
await tfl5.scope.patchBindings({ [userTid]: [{ scope: "O" }] }); // null clears a user's bindings
```

## 12. Signed sources — `tfl5.sources`

Register an inbound data channel for an external system to push into
one of your resources — tfl5 auto-mints the service principal, you never
supply a user id.

```ts
const src = await tfl5.sources.register({ name: "stripe-events", target_resource_ma: "order" });
console.log(src.ingest_url, src.secret); // secret is shown ONCE — store it now
const all = await tfl5.sources.list();    // secret omitted here
const rotated = await tfl5.sources.rotate(src.tid); // new secret, old one dead immediately
await tfl5.sources.revoke(src.tid);
```

The external system signs its push with HMAC-SHA256 over
`"<unix_ts_secs>.<raw_body>"` in `X-Tfl5-Timestamp` +
`X-Tfl5-Signature`; full push-side protocol in api-reference.md
§Signed sources.

## 13. Errors

Every rejection is a `Tfl5Error` subclass keyed on the server's stable
`code` — never on the (possibly localized) `msg`:

```ts
export class Tfl5Error extends Error {
  readonly code: string;      // e.g. "access_denied"
  readonly status: number;    // HTTP status (0 if the request never completed)
  readonly body: ErrorEnvelope;
}
```

| Class | Meaning |
|---|---|
| `UnauthorizedError` | 401 — session missing/expired |
| `AccessDeniedError` | 200 — authenticated, but lacks ACL on the target |
| `NotFoundError` | resource/doc/row not found |
| `BadRequestError` | 400 — malformed request / validation failure |
| `RateLimitError` | 429 — has an optional `.retryAfter` (seconds) |
| `InternalError` | 5xx — server-side failure |

```ts
import { NotFoundError, AccessDeniedError, RateLimitError } from "@tfl5/sdk";

try {
  await tfl5.resource("task").get("nope");
} catch (e) {
  if (e instanceof NotFoundError) { /* ... */ }
  else if (e instanceof AccessDeniedError) { /* ... */ }
  else if (e instanceof RateLimitError) { await sleep((e.retryAfter ?? 1) * 1000); }
  else throw e;
}
```

Some legacy error shapes ship on HTTP 200 with a `code` (e.g.
`not_found`, `access_denied`) rather than the matching HTTP status — the
SDK normalizes this: any response that isn't `{result: true}` throws,
regardless of the HTTP status code, so you never have to special-case
200-with-an-error yourself.

## 14. Config reference

```ts
interface Tfl5Config {
  host?: string;              // defaults to window.location.origin in a browser
  appId?: string;             // default app_tid auto-injected into request bodies
  auth?: "cookie" | "bearer"; // defaults to "cookie" in a browser, "bearer" in Node
  token?: string;             // bearer token; also settable via setToken()
  fetch?: typeof fetch;       // custom fetch — tests, non-standard runtimes
}
```

- **cookie** mode sends `credentials: "include"`; the server's `_token`
  cookie round-trips automatically.
- **bearer** mode sends `Authorization: Bearer <token>`; in Node (no
  cookie jar available to the platform) the SDK keeps an in-memory
  cookie jar internally so a `/login` cookie still persists across calls
  if you're in cookie mode outside a browser.
- `tfl5.useApp(appTid)` — scope subsequent calls; a per-call `app_tid` in
  the request body always overrides it.
- `tfl5.setToken(token)` — set/replace the bearer token manually (e.g.
  one minted out-of-band by a service).

## 15. Build & publish

See [sdk/README.md](../sdk/README.md) for the exact build/typecheck/publish
commands and the end-to-end smoke test that verifies this contract
against a real dev server. In short: `npm run build` emits the npm
package (`dist/`), `npm run build:browser` emits the bundles served at
`/sdk.js` / `/sdk.mjs` / `/sdk-ui.js` / `/sdk-ui.mjs`.

## 16. Versioning

- Semver once published; a major bump is a breaking change.
- The server and the SDK version independently — a server always serves
  the exact browser bundle it was built with (§1), so version skew only
  matters for the npm package against a REST contract that moved.
