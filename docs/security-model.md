# Security & confidentiality model

> Read this before you promise your end-users anything about privacy. It states
> **plainly what tfl5 protects, and what it does NOT** — so you don't accidentally
> tell a customer their data is "end-to-end encrypted" when it isn't.
>
> One-line summary: tfl5 is a **custodial** platform. Your data is strongly
> encrypted **at rest against outsiders and DB theft**, but the **platform
> operator can decrypt it** (they hold the keys). It is **not zero-knowledge**.

---

## 1. The trust boundary — the client is never trusted

Every access decision is made **server-side**. The browser/SDK is treated as
hostile input:

- ACL (all 4 layers — see [acl-model.md](acl-model.md)), [scope](scope.md), quota,
  and rate limits are enforced on the server. A raw API call that skips your UI
  gets exactly the same checks as a click.
- Client-side "hide the button" logic is **UX only**, never a security control.
  If a field must be hidden from a role, hide it on the server (encryption level /
  scope PII level), not just in the SPA.

**Takeaway:** you can build a UI that trusts the server's answers; you cannot build
security by trusting the client.

⚠ **But know which layer fences what.** "Enforced server-side" is not the same as
"every array you populate restricts every operation". In particular, per-doc ACL
arrays do **not** filter `/app/doc/list` or `/app/doc/get` — doc reads are fenced by
the app level, the resource-type ACL, and scope. If a row must be invisible to
someone holding app-Reader, fence it with the resource ACL or
[scope](scope.md), and read [acl-model.md §5](acl-model.md) before you promise a
customer that "only their own records are visible".

---

## 2. Encryption at rest — what's encrypted, and how

Fields are tiered by a `level` you set in the resource schema
([recipes.md §6](recipes.md), [api-reference.md](api-reference.md) Resources):

| Level | Name | Storage | Searchable? |
|-------|------|---------|-------------|
| 0 (default) | public | `data_indexed` — **plaintext** JSONB, GIN-indexed | yes (`/app/doc/list where:`) |
| 1 | sensitive | `data_secret` — **encrypted** (AEAD) | no |
| 2 | top-secret | `data_secret` — **encrypted** (AEAD) | no |
| 3 | per-grantee sealed | **not in doc fields** — use [F3 attachments](api-reference.md) | n/a |

- Encryption is **ChaCha20-Poly1305** with per-field AAD bound to
  `doc_tid | field_name`, so a ciphertext can't be cut-and-pasted onto another doc
  or field.
- Keys are **envelope-wrapped**: each app has its own data key (DEK), wrapped by
  the cell's **master key** (KEK). The master key supports two-key rotation with a
  background re-encryption walker.
- **Anything you don't mark level ≥ 1 is stored plaintext** in `data_indexed`
  (that's what makes it filterable). A field you *forget* to tag lands in
  plaintext — tag sensitive fields deliberately.

⚠ **Level 1 vs level 2 are NOT an access tier.** Both are encrypted identically,
and **any caller who passes the doc's Reader ACL + scope gets the decrypted value
back in the response JSON.** "Level 2" does not mean "fewer people can read it" —
that's what ACL, scope, and the scope **PII level** (§4) are for. Encryption-at-rest
protects against the *storage/DB*, not against an *authorized reader*.

---

## 3. Custodial, NOT zero-knowledge — say this to your customers

**On every authorized read, the server unwraps the DEK, decrypts `data_secret`,
and returns plaintext in the response.** That means:

| Who | Can read your tenant's sensitive data? |
|-----|-----------------------------------------|
| An outsider with **only** a stolen DB dump | **No** — `data_secret` is ciphertext; keys aren't in the DB |
| The **platform operator** (holds the master key + server access) | **Yes** |
| Your app's code / a WASM operator running on the server | Yes (server-side, under the caller's ACL) |
| A **user**, via the API | Only what their ACL + scope allow (decrypted for them) |

So tfl5 gives you: **encryption at rest against DB theft and external attackers**,
per-app key isolation, key rotation, and AEAD integrity. It does **not** give you:
**zero-knowledge / end-to-end / tenant-held-key** confidentiality — there is no
path today where the server cannot read the plaintext.

**If your compliance story requires "the platform operator cannot read this data,"
tfl5 does not provide it out of the box.** Your options:

1. **Client-side E2E (only true zero-knowledge path today).** Encrypt in your own
   client with a key the server never sees (derived from a user passphrase or held
   on the device), and store the **ciphertext as opaque bytes** in a level-1 field
   or an [F3 attachment](api-reference.md). tfl5 stores blind bytes; only your
   client decrypts. This is *your* code, not a tfl5 feature.
2. **F3 sealed attachments** (below) — better than plain field encryption for
   "only granted users open it", but still custodial (the master key wraps the
   private keys).
3. A hardware enclave / TEE — **not** provided by tfl5.

Putting the crypto inside a **server-side WASM operator does not help** — operators
run in-process, the host can read guest memory, and their keys come from the same
custodial store. WASM only achieves zero-knowledge when it runs in **your client**.

---

## 4. F3 sealed attachments — per-grantee "only key-holders open it"

For "content only specific users can decrypt", tfl5 has **F3** (see
[api-reference.md](api-reference.md) `/app/f3/*`):

- Each user has an **X25519 keypair** (public key plaintext, used to seal; private
  key **wrapped by the master key**).
- A file's DEK is **sealed per-grantee** to their public key
  (`f3_grants.sealed_dek`); to read, the grantee opens the grant with their private
  key. Granting = re-sealing the DEK to another user's public key.
- This is the closest tfl5 gets to "you need a key to read it." **But it is still
  custodial:** the private keys are master-key-wrapped, so the operator can open any
  grant. It protects against a DB-only attacker, not against the operator.

---

## 5. PII masking on read (rides on scope)

When [scope](scope.md) is enforced, a caller's binding can carry a **PII level** so
that even an *in-scope* row comes back with sensitive fields **masked**. Three
levels, wire codes `F` / `M` / `A`:

| Level | Code | Effect on a row the caller is otherwise allowed to read |
|---|---|---|
| Full | `F` | unchanged (the default when a binding declares no level) |
| Masked | `M` | fields listed in `pii_fields` are rewritten before the response |
| Aggregate | `A` | row-level reads are refused; the caller may only count/aggregate |

Which fields get masked, and how, is per-resource **data**, declared at
`apps.acls.scope.field_map.<resource>.pii_fields` as `{field: kind}`:

- `name` → initials joined with `.` (`"Nguyễn Văn An"` → `"N.V.A"`)
- `cccd` / `phone` → all but the last 4 characters (`"****1234"`)
- `email` → first character of the local part (`"a***@xyz.com"`)
- any **unrecognised** kind → `"***"` (a typo in `pii_fields` fails closed rather
  than leaking the field)

Multiple matching bindings resolve to the **least-strict** level. Without scope
enforced, no masking is applied.

**Aggregate drill-down is possible, and it is logged.** An `A`-level caller hitting
`/app/doc/get` is refused with `pii_aggregate_only` — *unless* they supply an
`X-Audit-Reason` header, in which case the read is escalated to Full and recorded
with `drill_down=true` plus the reason text. That is a deliberate break-glass path,
not a leak: design your roles knowing an `A`-level user can reach Full data by
stating a reason. Refused attempts are logged too.

---

## 6. Auditing & traceability

Every meaningful mutation writes a row to the platform audit log, with a
**server-resolved** actor (not client-supplied) and timestamp. Two read surfaces:

- `POST /app/audit/list` — the **per-app** feed, gated on Manager of that
  `app_tid`. The authorised tid is also the query scope, so there is no way to read
  another app's audit through it. Payload bodies are omitted unless you ask for
  `include_payload`, and the window is capped at 90 days per call.
- `POST /admin/audit/{list,get,summary}` — the platform-wide view, platform-admin
  only.

Two more tables complete the picture: PII reads on `/app/doc/{list,get}` write a
row to the PII access log when scope is enforced (one row per *request*, carrying
`row_count` — not one row per record returned), and F3 attachment opens write their
own access-log row, readable via `/app/f3/access-log`. Both writes are
**best-effort**: a failure is logged and the request still succeeds, so the access
log is evidence, not a hard gate. Ordinary `/app/file/*` downloads do **not** write
a PII access-log row.

### Tamper-evidence: a signed hash-chain (and exactly what it proves)

Audit rows are written unsealed (the hot path takes no extra latency), and a
background sealer chains them a few seconds later, per cell, single-writer. Each
sealed row carries:

- **`entry_hash`** — SHA-256 over the row's canonical content *including* its
  sequence number and the previous row's hash. Recomputed at verify time; a
  mismatch means the row was edited after sealing.
- **`signature`** — HMAC-SHA256 over `entry_hash` under the deployment's key, so a
  party without the key cannot forge a fresh hash to match an edited row.
- **`prev_hash` + `chain_seq`** — linkage and ordering, so re-ordering or re-linking
  a row breaks verification.

`POST /admin/audit/verify` (platform-admin) walks a cell's chain and returns
`signature_failures`, `linkage_breaks`, `gaps`. Signature failures and linkage
breaks are hard tamper verdicts; **gaps are informational only**, because a
legitimate retention prune or an erasure exemption also leaves a gap.

⚠ **Say this precisely, because it is easy to oversell.** The signing key is held
by the **platform operator** — signing is **custodial**, exactly like the encryption
in §3. The chain therefore proves tampering by anyone *without* the key:
application bugs, lower-privilege actors, storage corruption, casual editing. It
does **not** make the log insider-proof — an operator holding the key can edit a row
and re-chain it. There is also a **seal-lag window**: rows written in the last few
seconds are not yet sealed and so are not yet covered.

Insider-proof immutability needs the chain head anchored **off-box** (WORM sink or
external anchoring). That is an open operator-side item, not a shipped default. If
your regulatory posture requires operator-proof audit, plan for that step and do not
market the built-in chain as an immutable ledger.

---

## 7. Supply chain: what JavaScript can run in your users' browsers

A published page is only as trustworthy as the code it loads. The platform's
`Content-Security-Policy` on HTML responses allows scripts from `'self'` plus
**exactly two** third-party origins — Google Identity Services and the Telegram
login widget. Those two stay because a provider widget only functions when loaded
from the provider's own origin; everything else is gone.

Every other third-party browser library the platform ships (charts, QR rendering,
the Microsoft sign-in library, the code-editor library) is served **from the
platform's own origin** under `/_tfl5/vendor/<file>`, compiled into the server
binary. That matters for three concrete reasons:

1. **No CDN host allowlist.** Allowing a CDN host authorises every file that host
   will ever serve, and there is no subresource-integrity pin available when a
   provider updates in place. Dropping the host is strictly smaller than any
   allowlist.
2. **Provenance is pinned, not assumed.** Each vendored file is extracted from the
   publisher's own npm registry tarball and recorded in a lock file with package,
   version, the exact path inside the tarball, and a SHA-256. A build-time test
   re-hashes the bytes compiled into the binary against that lock, so a hand-edited
   vendor file fails the build rather than shipping inside a minified blob. A second
   test scans the shipped browser assets and fails the build if any of them reaches
   for a host outside the CSP allowlist.
3. **No third-party availability or privacy dependency.** A CDN outage cannot break
   charts on published pages, and your visitors' IP addresses are not disclosed to a
   CDN.

Version numbers are part of the vendored filenames, so those URLs are safely
long-cached and a version bump changes the URL rather than silently re-pointing
cached clients.

The remaining honest caveat: the policy still includes `'unsafe-inline'` for
`script-src` and `style-src`, so CSP is not currently a defence against an injected
inline script. Treat output escaping in your own app as the primary XSS control;
CSP here is defence-in-depth against *third-party host* compromise, not against
your own template bugs.

---

## 8. Published site content is public by contract

When you publish a site through the content-addressed engine
(`/app/site/*`, see [README](README.md)), the served bytes are **public**. The
`/app/site/*` authoring endpoints are Manager-gated, and the in-editor
`/app/site/preview` of an unpublished draft is Manager-gated — but once a snapshot
is live, the serve path resolves `path → entry → blob` and returns the bytes with
no per-file permission check. The schema reserves a per-entry ACL field, but
**nothing populates or enforces it today**.

Practical rule: **never put a secret in a published site file.** Anything that must
be access-controlled belongs in a doc (`/app/doc/*`, four ACL layers), a file with
per-row ACL (`/app/file/*`), or an F3 attachment (§4) — not in the site bundle.
This is the same contract the older bundle publish path had; the versioning engine
did not change it.

---

## 9. Sandboxed operators can't exfiltrate

[WASM operators](api-reference.md) run in a strict sandbox: **no network, no
filesystem, no clock, no ambient capability** — the only imports linked into the
guest are the two audited host calls (`host_log`, `host_call`), and `host_call`
runs under the **caller's** ACL + scope (`create`/`update` re-run the same
app-level Editor gate as the HTTP write paths, and the write is scope-checked).
A buggy or malicious operator is bounded on CPU (fuel-metered), memory (a
resource limiter), wall clock, host-call count, and host-call payload size — and
has **no channel to send your data out**. It is a safe place to run
tenant-authored server logic; it is **not** a confidentiality boundary against the
operator (§3).

---

## 10. Things that are OFF unless the operator turns them on

Do not assume a subsystem is live just because its endpoints exist in the API
reference. Three defaults worth knowing when you scope a project:

| Subsystem | Default | Turned on by |
|---|---|---|
| Row-level [scope](scope.md) enforcement | **off** | `TFL5_ENFORCE_SCOPE` on the cell, *and* a per-app `field_map` |
| Durable operator subsystem | **off** | `TFL5_DURABLE_ENABLED`; every durable endpoint returns "not enabled on this deployment" until then |
| Payment providers | **off** | a provider is registered only if its webhook secret is in the environment; an unconfigured provider is indistinguishable from a 404 |

The pattern is deliberate — a new subsystem is opt-in, never on by default. Ask
your operator which are enabled on the cell you're deploying to, and don't design a
security control around scope until you've confirmed it enforces (see
[scope.md §6](scope.md)).

---

## 11. Checklist — before you promise privacy

- ✅ "Encrypted at rest, safe if the database is stolen" — **true** for level ≥ 1
  fields and F3.
- ✅ "Access is enforced by the server, not the client" — **true**.
- ✅ "Only granted users can open this file" — **true** with F3 (custodially).
- ✅ "Third-party JavaScript can't be swapped under us" — **true** for what the
  platform serves: self-hosted, provenance-locked, build-gated (§7). Two provider
  widgets are the documented exception.
- ⚠ "Tamper-proof audit trail" — it is **signed and tamper-evident** (§6), which
  detects edits by anyone without the operator's key. It is **not** operator-proof
  and not yet anchored off-box; don't market it as an immutable ledger.
- ❌ "The platform / the vendor cannot read this" — **false** unless you do
  client-side E2E yourself.
- ❌ "End-to-end / zero-knowledge encrypted" — **false** for platform-side
  encryption. Only your own client-side E2E earns that phrase.
- ❌ "Files on our published site are private" — **false**. Published site content
  has no per-file ACL (§8).

When in doubt, describe it as **"custodial, encrypted at rest, with a
tamper-evident audit log"** — accurate, and it won't come back to bite you in a
compliance review.
