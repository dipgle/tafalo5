# tfl5 Documentation Index

Entry point for **developers and AI agents** building apps on top of
tfl5 without modifying the Rust core.

## Reading order

### If you're new (read in order)
1. **[app-builder-guide.md](app-builder-guide.md)** — concepts,
   building blocks, app lifecycle, walkthrough. Start here.
2. **[acl-model.md](acl-model.md)** — authorization model (the 4 layers:
   app → resource → per-row → scope). Read in full before designing any
   data model. The ACL arrays are THE most-common source of foot-guns; don't skip.
3. **[scope.md](scope.md)** — row-level scope (field-based fencing). Read
   if users should see only *their* rows (own records, per-company, per-class)
   without minting a role token per row.
4. **[security-model.md](security-model.md)** — the confidentiality & trust
   model. **Read before you promise your end-users anything about privacy** —
   tfl5 is custodial (encrypted at rest, but the operator can read it), NOT
   zero-knowledge. Also covers PII masking, the tamper-evident audit chain
   and its limits, what JavaScript may run in your users' browsers, and
   which subsystems ship switched off.
5. **[api-reference.md](api-reference.md)** — endpoint-by-endpoint
   reference. Lookup as you build.
6. **[recipes.md](recipes.md)** — practical "how do I X?" patterns
   (audit, bulk move, share with expiry, encrypted field, …).
   Search this when you hit a task.

### If you're an AI agent picking up this folder
Read app-builder-guide.md → acl-model.md → scope.md → security-model.md →
api-reference.md. Pull
api-reference.md sections on demand by endpoint. These files are the
complete contract — nothing outside this folder is required to start
building.

## What's NOT covered here

- **tfl5 core internals** (architecture diagrams, decision rationale,
  deployment runbooks, testing strategy) are internal-team material
  and not in this folder. Ask the tfl5 platform team if a "why was
  it designed this way?" question blocks you.
- **The in-UI editor and no-code builder themselves.** These now
  exist (see "What the platform GIVES you" below) and ship as part of
  the admin surface. This folder documents the **API contract** a
  human or AI agent codes against; it is not a click-by-click manual
  for those UIs.
- **AI-generate-a-frontend-from-a-prompt** — still a vision item, not
  built.

## What the platform GIVES you

| Capability | Endpoint family | Read |
|---|---|---|
| Auth (email/password, magic link, Google, Microsoft, QR, Telegram, phone OTP, VNeID) | `/reg`, `/login`, `/auth/*` | api-reference §Authentication |
| TOTP two-factor auth + backup codes, gated to the caller's own account | `/user/2fa/*` | api-reference §Authentication |
| Multi-tenant apps with domain binding + subdomain delegation | `/app/*`, `/app/domain/*` | api-reference §Apps + §Domains |
| Schema-defined data (resources + docs) with field-level encryption | `/app/resource/*`, `/app/doc/*` | api-reference §Resources + §Docs |
| File upload (binary attachments) with per-file ACL + signed URLs | `/app/file/*` | api-reference §Files |
| **Content-addressed site publishing** — blobs + immutable snapshots, publish = pointer flip, one-click rollback, per-file history | `/app/site/*` | §"Publishing a site" below |
| **In-UI code editor + no-code page builder** shipped in the admin surface, both writing to the same `/app/site/*` engine. Builder pages are a JSON component tree rendered server-side; the injected runtime does read + write-back CRUD through the ordinary `/app/doc/{list,create,update,del}` endpoints, so **every ACL layer still applies** | `/app/site/*`, `/app/doc/*` | acl-model.md |
| Roles + per-row ACL with role tokens | `/app/role/*` | acl-model + api-reference §Roles |
| Resource-type ACL (gate a whole KIND of data) | `/app/resource/update` | acl-model §Resource-level ACL |
| Row-level scope — users see only *their* rows by a data field (own/company/class), env-gated | `/app/scope/*`, `apps.acls.scope` | scope.md |
| Custodial field-level encryption (at-rest; NOT zero-knowledge) + F3 per-grantee sealed attachments | `/app/doc/*` levels, `/app/f3/*` | security-model.md |
| Read-only sharing with field whitelist + anonymous tokens | `/app/share/*` | api-reference §Sharing |
| Anonymous public form submissions (waitlist / contact / NPS) with per-IP rate limit | `/app/public-form/submit` | api-reference §Public forms |
| Bulk data in: batch create, upsert, and `.xlsx` import (with preview) through the normal validation/hook/ACL pipeline | `/app/doc/{create-batch,upsert,import,import-preview}` | api-reference §Docs |
| Test/release stages + atomic promote | `/app/test/*`, `/app/release*` | api-reference §Stages |
| Declarative hooks — `require_fields`, `set_fields`, `webhook`, `wasm` | `resources.hooks` JSONB | app-builder-guide §5.2 |
| Official integrations: email, VietQR, VNeID, Zalo ZNS, Viettel SMS* | `/app/integrations/*`, `/op/<id>/<action>` | api-reference §Operators |
| **WASM operators** — tenant server-side code, sandboxed + ACL-scoped (lifecycle hook or HTTP) | `/app/wasm/*`, `/op/<id>/<action>` | api-reference §Operators → WASM |
| **Signed sources** — HMAC-authenticated ingest from external systems (HIS, payment gateway, IoT); write runs AS an auto-provisioned service principal through the same ACL gate as any user | `/app/source/*`, `/ingest/:source_tid` | api-reference §Signed sources |
| WebSocket chat (session-authenticated, Reader-gated per app, persisted scrollback) | `/ws/chat`, `/app/chat/history` | api-reference §Chat |
| License tiers, per-app quota, and app-creation rights bought in quantity packs | `/license`, `/licenses/*`, `/app/upgrade-license/*` | api-reference §License |
| Self-service data export + erasure request/cancel | `/user/data/{export,erase,erase/cancel}` | api-reference §Users |
| Audit trail (per-app feed, signed hash-chain) + outbox + hook invocation log | `/app/audit/list` | security-model §6 |

*Both messaging operators dispatch over real HTTP today. What's still on
you is **external credential onboarding** — registering the Official
Account / brand-name and CP code with the provider, then supplying the
credentials via `/app/integrations/config-set`. Flagged inline in
api-reference.md.

### Publishing a site

The current publish path is content-addressed and versioned:

- `/app/site/put` / `/app/site/delete` mutate a **draft** working tree.
  Identical bytes are stored once (deduplicated by content hash) across
  versions and across apps.
- `/app/site/publish` freezes the draft into an **immutable snapshot** and
  flips one pointer — that single-row update is the commit point, so a
  crash mid-publish can never expose a half-published site. An empty draft
  is refused rather than silently wiping the live site.
- `/app/site/rollback` flips the pointer to any earlier snapshot;
  `/app/site/history` and `/app/site/file-history` give per-app and
  per-file history; `/app/site/preview` renders the draft for the author
  without touching the live site.
- `/app/site/backfill` imports an app's existing published tree into a
  snapshot, so migrating is self-service.

All `/app/site/*` endpoints are Manager-gated. **Serve precedence** is
`live snapshot → activated bundle version → pinned release version →
legacy public tree`; an app with no live snapshot keeps its exact previous
behaviour, so adopting the engine is opt-in per app. Older snapshots and
their unreferenced blobs are reclaimed by a background collector that never
touches the live or draft pointers.

⚠ Published site content is **public** — the serve path applies no per-file
permission check. See [security-model.md §8](security-model.md).

## What the platform does NOT give you (today)

These are real gaps that affect design decisions. See
app-builder-guide §7 for detail.

- Marketplace / app catalog — not built
- General aggregate / GROUP BY query API — not built. Declarative
  **rollup fields** on a resource are computed at read time for
  `/app/doc/list`, which covers parent→children sums/counts; anything
  broader needs pre-computation
- Filter `/app/doc/list` by nested or encrypted (`level ≥ 1`) fields —
  a level-0 filter shipped (`where` clause: equality, plus IN-semantics
  for an array value, max 10 keys). A nested object is rejected with
  `cannot_filter_nested` and an encrypted field with
  `cannot_filter_encrypted_field` — deliberately loud, never a silently
  wrong match. Deeper filters require client-side narrowing or a
  hook-maintained level-0 mirror
- Batch update — workaround: N sequential POSTs. Batch create is
  available via `/app/doc/create-batch`, insert-or-update via
  `/app/doc/upsert`, and `.xlsx` bulk load via `/app/doc/import`
- Cross-resource transactions — workaround: compensate in FE
- Configurable cron inside tfl5 — workaround: external cron
- Per-file permissions on **published site content** — the site serve
  path is public by contract; use docs/files/F3 for anything gated
- Tenant-defined endpoints — by design; logic flows through
  doc/file/operator + your external services

## Things that are OFF unless the operator turns them on

Endpoints existing in api-reference.md does not mean the subsystem is live
on the cell you deploy to. Confirm with your operator before designing
around any of these:

| Subsystem | Default |
|---|---|
| Row-level [scope](scope.md) enforcement | **off** (needs a cell env flag *and* a per-app `field_map`) |
| Durable operator subsystem | **off**; its endpoints answer "not enabled on this deployment" |
| Payment providers | **off**; a provider is registered only when its webhook secret is configured |

## Quirks to know

One non-blocking quirk across the API surface — design around it:

- **Soft-fail responses still return HTTP 200** with `{result: false,
  code, msg}`. Always check `result` (and `code` for the specific
  failure) — don't rely on HTTP status alone. (`/app/update` also uses
  a `{tid?, data:{name, ...}}` wrapper while other `/app/*` endpoints
  are flat — look at api-reference §Apps for shape per endpoint.)

## Conventions you should follow

| When you... | Do this |
|---|---|
| Need a new endpoint | Ask the tfl5 team. Don't invent workarounds; check api-reference §<group> first to confirm it doesn't already exist under a different name. |
| Add a role / change role members | Use `/app/role/*` — see acl-model §6. |
| Need server-side validation | Use a `require_fields` declarative hook — see app-builder-guide §5.2. |
| Need to fire a notification | Use a `webhook` hook, or `/app/email/send` for email. ZNS/SMS via `/op/<id>/send` — dispatch works; you supply the provider credentials via `/app/integrations/config-set`. |
| Ship third-party JavaScript to your users | Bundle it into your own published assets. The platform's CSP allows scripts from its own origin plus two provider widgets only — a CDN `<script>` tag will be blocked. See [security-model.md §7](security-model.md). |
| Publish a site / roll a bad deploy back | `/app/site/publish` then `/app/site/rollback` — don't hand-edit the served tree. |
| Need to store sensitive PII | Mark the resource field `level: 1` or `2` — see app-builder-guide §5.1. **Then read [security-model.md](security-model.md)** so you describe it correctly (custodial, not zero-knowledge). |
| Need users to see only *their own* rows | Use [scope](scope.md) (fence by a data field) — don't mint a role token per row. |
| Need "only the vendor can't read it" (zero-knowledge) | tfl5 does NOT provide it — do client-side E2E yourself; see [security-model.md](security-model.md) §3. |
