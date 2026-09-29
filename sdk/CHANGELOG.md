# Changelog

## Unreleased

No code change. Package metadata and README only:

- `package.json` `repository`, `bugs` and `homepage` point at
  `github.com/dipgle/tafalo5` (folder `sdk/`), where the package actually
  lives; they pointed at a repository that does not hold it.
- README: the Errors example did not compile under `strict` (undefined
  `sleep`, `e.code` on an `unknown`); it now does, and the README names the
  methods that resolve `result: false` instead of throwing. Role-token
  brackets: which calls add them for you and which store arrays as sent.

## 0.2.0 — 2026-09-27

Checked every method against the server it calls. Several methods never
worked; they are fixed here, which changes their signatures. This release
also merges the two copies of the SDK that had drifted apart (the one served
by the platform at `/sdk.js` and the 0.1.0 published in this repository).

### Upgrading from the 0.1.0 published in this repository

| STT | 0.1.0 | 0.2.0 |
|---|---|---|
| 1 | `tfl5.bundles`, `tfl5.domains`, `tfl5.publicForms`, `tfl5.scope` | unchanged (also `tfl5.bundle`, `tfl5.domain`, `tfl5.publicForm`, `tfl5.access.scope*`) |
| 2 | `files.rename(id, name)`, `files.del(id)`, `files.restore(id)` | `files.rename(path, newPath)`, `files.del(path)`, `files.restore(fileTid)` — the 0.1.0 forms were rejected by the server |
| 3 | `files.list(path)` | `files.list({ stage, prefix })` |
| 4 | `site.del(path)`, `site.backfill()` | `site.delete(path)`, `site.importCurrent()` |
| 5 | `durable.mailGrantCreate/List/Revoke` | `durable.grantMail`, `listMailGrants`, `revokeMail` |
| 6 | `billing.creditsBalance/Checkout/Ledger/Packs` | `billing.credits.balance/checkout/ledger/packs` |
| 7 | `billing.invoiceIssue/Get/Pdf/Email` | `billing.invoices.issue/get/pdf/email` |
| 8 | `billing.serviceList`, `billing.serviceRedeem` | `billing.services()`, `billing.redeem()` |
| 9 | `billing.license*`, `setupTenant`, `redeemLicenseToken`, `myLicenseTokens` | `tfl5.license.*` |
| 10 | `auth.phoneVerify(phone, otp)` sent `otp` | same call; now sends the field the server reads |
| 11 | hooks on `before_delete` / `after_delete` | `before_del` / `after_del` (the old names never fired) |
| 12 | Node default `bearer` | Node default `cookie` (login works in Node) |

### Fixed

- **In a browser, every call failed** with `TypeError: Illegal invocation`
  unless you passed your own `fetch` — in the 0.1.0 published here and in the
  copy served at `/sdk.js`. The client called the global `fetch` as a method
  of its own object, which browsers refuse. `sdk/smoke/browser.mjs` now loads
  the bundle in a real browser and fails on this.

### Breaking

- `files.rename(path, newPath)`, `files.del(path)` and
  `files.restore(fileTid)` — previously took an id and were rejected by the
  server on every call.
- `files.upload(parts, { stage })`: `path` is the file's full path.
  `files.list({ stage, prefix })` replaces `files.list(path)`, whose argument
  was ignored.
- `auth.qrStart()` resolves `{ session_id, approve_url, … }`;
  `auth.qrPoll(sessionId)` resolves `{ status, user? }`. Polling used to fail
  on every call.
- `auth.phoneVerify(phone, code)` now sends the code under the name the
  server reads (it failed on every call).
- `apps.transferOwnership(appTid, newOwnerTid, { keepOldAsManager, reason })`
  (failed on every call).
- `apps.invite({ email, roleTids })` — roles were silently dropped before,
  and `email` is required. `apps.members()` resolves
  `{ members, total, nextOffset }`.
- In Node the default auth mode is now `cookie` (unless you pass a `token`).
  `/login` never returns a bearer token, so the old default left Node
  clients signed out after a successful login.
- A signed-out call to endpoints that answer `{ isSignout: true }` with
  HTTP 200 (such as `auth.me()`) now throws `UnauthorizedError` instead of
  resolving the envelope.
- `HookEvent` uses the server's names `before_del` / `after_del`; hooks
  declared with `before_delete` / `after_delete` were stored but never fired.
- Doc writes resolve what the server returns: `create` → `{ tid, resource_tid }`,
  `update`/`patch` → `{ tid }`, `upsert` → `{ tid, created, resource_tid }`,
  `createBatch` → `{ tids, count, failures? }`.
- `account.profile()`, `account.emailList()`, `license.myTokens()` resolve the
  payload itself instead of the response envelope.
- `shares.claim(token, appTid)` resolves `{ doc_tid, data, … }`.
- `stages.promote()` reports the queued job (`{ queued, job_id }`) and, like
  `rollbackRelease()`, resolves `result: false` instead of throwing.
- `files.upload()` resolves `{ files, warnings? }`; `rename()`/`del()` resolve
  what the server did (and `warnings`).
- `durable.send()` throws for refusals (access denied, not found) instead of
  resolving them as a delivery outcome.
- `f3.download()` resolves `{ bytes, blob, filename, mimeType }` (the served
  0.1 build resolved `undefined`).

### Added

- From the 0.1.0 public SDK: the live chat socket (`chat.connect`,
  `chatResumeCursor`) and room settings; public-form admin
  (`setConfig`, `getConfig`, `list`); `PaymentRequiredError`,
  `TokenScopeDeniedError`, `TokenScopeUnavailableError`; `warnings` on file
  writes shadowed by a live site; download filenames; typed audit rows;
  `durable.send` retry information. In Node the chat socket now carries the
  session (0.1.0 connected signed out).
- `tfl5.site` — the site engine: draft, publish, roll back, history, preview.
- `tfl5.billing` — catalog, checkout, plan changes, credits, invoices,
  entitlement tokens.
- `tfl5.identity` — share avatar / display name by grant.
- `tfl5.platform` — public sign-in settings and server version.
- `tfl5.resources` — list, create (with resource ACL), constraints, orphan
  cleanup, CSV/XLSX import preview; `resource(ma).importFile()`,
  `listPage()` (keyset cursor) and `destroy()`.
- Files: `save`, `get`, `aclSet`, `trashList`, `purge`; stage options.
- Auth: `qrApprove`, `qrReject`, Telegram, VNeID, `redirectTo` options.
- Durable: `stats`, mail grants. Bundles: `delete`. Stages: `releaseStatus`.
- `apps.searchMembers`, `license.setupTenant`, `chat.history` forward cursor.
- `HttpCore.get`, `postEnvelope`, `postBlob`, `urlFor`.
- Documentation in `docs/`, with `docs/reference.md` generated from the source
  (`npm run docs:check` fails when it is stale).
- MIT license.

## 0.1.0

First version, served by the platform at `/sdk.js`.
