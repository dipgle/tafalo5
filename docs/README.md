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
   zero-knowledge.
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
- **No-code visual builder** — does NOT exist today. The platform
  vision includes two future paths (auto-render runtime from
  resource schema + AI-generate FE from natural-language prompts),
  but neither is built. Until then, "building an app on tfl5"
  means a human (or an AI agent) writes HTML/JS using the contract
  in this folder.

## What the platform GIVES you

| Capability | Endpoint family | Read |
|---|---|---|
| Auth (email/password, magic link, Google, QR, Telegram, phone OTP*, VNeID*) | `/reg`, `/login`, `/auth/*` | api-reference §Authentication |
| Multi-tenant apps with domain binding + subdomain delegation | `/app/*`, `/app/domain/*` | api-reference §Apps + §Domains |
| Schema-defined data (resources + docs) with field-level encryption | `/app/resource/*`, `/app/doc/*` | api-reference §Resources + §Docs |
| File upload (static FE + binary attachments) with per-file ACL | `/app/file/*` | api-reference §Files |
| Roles + per-row ACL with role tokens `[r_xxx]` | `/app/role/*` | acl-model + api-reference §Roles |
| Resource-type ACL (gate a whole KIND of data) | `/app/resource/update` | acl-model §Resource-level ACL |
| Row-level scope — users see only *their* rows by a data field (own/company/class), env-gated | `/app/scope/*`, `apps.acls.scope` | scope.md |
| Custodial field-level encryption (at-rest; NOT zero-knowledge) + F3 per-grantee sealed attachments | `/app/doc/*` levels, `/app/f3/*` | security-model.md |
| Read-only sharing with field whitelist + anonymous tokens | `/app/share/*` | api-reference §Sharing |
| Test/release stages + atomic promote | `/app/test/*`, `/app/release` | api-reference §Stages |
| Declarative hooks (`require_fields`, `set_fields`, `webhook`) | `resources.hooks` JSONB | app-builder-guide §5.2 |
| Official integrations: email, VietQR, VNeID, Zalo ZNS*, Viettel SMS* | `/app/integrations/*`, `/op/<id>/<action>` | api-reference §Operators |
| **WASM operators** — tenant server-side code, sandboxed + ACL-scoped (lifecycle hook or HTTP) | `/app/wasm/*`, `/op/<id>/<action>` | api-reference §Operators → WASM |
| **Signed sources** — HMAC-authenticated ingest from external systems (HIS, payment gateway, IoT); write runs AS an auto-provisioned service principal through the same ACL gate as any user | `/app/source/*`, `/ingest/:source_tid` | api-reference §Signed sources |
| License tiers + per-app quota | `/license`, `/app/upgrade-license/*` | api-reference §License |
| Audit trail (per-app feed) + outbox + hook invocation log | `/app/audit/list` | api-reference §Audit |

*Scaffold shipped; HTTP send/dispatch wiring + external credential
onboarding pending. Flagged inline in api-reference.md.

## What the platform does NOT give you (today)

These are real gaps that affect design decisions. See
app-builder-guide §7 for detail.

- Marketplace / app catalog — designed, not built
- Aggregate / GROUP BY query API — workaround: pre-compute via cron
- Filter `/app/doc/list` by nested or encrypted (`level ≥ 1`) fields —
  level-0 equality filter shipped in Batch 85 (`where` clause); deeper
  filters require client-side narrowing or a hook-maintained mirror
- Batch update — workaround: N sequential POSTs. Batch create shipped
  in Batch 85 via `/app/doc/create-batch`; insert-or-update via
  `/app/doc/upsert` (Batch 85.2)
- Cross-resource transactions — workaround: compensate in FE
- Configurable cron inside tfl5 — workaround: external cron
- WebSocket first-party handler (chat, presence) — workaround:
  external service
- Tenant-defined endpoints — by design; logic flows through
  doc/file/operator + your external services

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
| Need to fire a notification | Use a `webhook` hook, or `/app/email/send` for email. ZNS/SMS via `/op/<id>/send` once those operators are fully wired. |
| Need to store sensitive PII | Mark the resource field `level: 1` or `2` — see app-builder-guide §5.1. **Then read [security-model.md](security-model.md)** so you describe it correctly (custodial, not zero-knowledge). |
| Need users to see only *their own* rows | Use [scope](scope.md) (fence by a data field) — don't mint a role token per row. |
| Need "only the vendor can't read it" (zero-knowledge) | tfl5 does NOT provide it — do client-side E2E yourself; see [security-model.md](security-model.md) §3. |
