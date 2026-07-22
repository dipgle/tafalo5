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
that even an *in-scope* row comes back with sensitive fields **masked** (name →
initials, id → last-4, email → `a***@domain`, or fully withheld). Multiple matching
bindings resolve to the **least-strict** level. This is the mechanism for
"role A may list students but not see their national IDs." Without scope enforced,
no masking is applied.

---

## 6. Auditing & traceability

Every meaningful mutation writes a row to the platform audit log
(`/admin/audit/list`), with a **server-resolved** actor (not client-supplied) and
timestamp; sensitive resources can additionally record a before→after content hash.
PII reads (`/app/doc/{list,get}`, file access) record an access-log row when scope
is enforced.

Scope + honesty note: this is a **platform-managed** operational log for
traceability, not a customer-controlled immutable ledger — it lives in the same
database the operator administers. If your regulatory posture needs *tamper-evident,
operator-proof* audit (e.g. WORM / off-box shipping), that is an operator-side
hardening step, not a default guarantee. Design accordingly.

---

## 7. Sandboxed operators can't exfiltrate

[WASM operators](api-reference.md) run in a strict sandbox: **no network, no
filesystem, no clock, no ambient capability** — only the two audited host calls
(`host_log`, `host_call`), and `host_call` runs under the **caller's** ACL + scope
(writes require Editor). A buggy or malicious operator is CPU/memory/time-bounded
and has **no channel to send your data out**. It is a safe place to run
tenant-authored server logic; it is **not** a confidentiality boundary against the
operator (§3).

---

## 8. Checklist — before you promise privacy

- ✅ "Encrypted at rest, safe if the database is stolen" — **true** for level ≥ 1
  fields and F3.
- ✅ "Access is enforced by the server, not the client" — **true**.
- ✅ "Only granted users can open this file" — **true** with F3 (custodially).
- ❌ "The platform / the vendor cannot read this" — **false** unless you do
  client-side E2E yourself.
- ❌ "End-to-end / zero-knowledge encrypted" — **false** for platform-side
  encryption. Only your own client-side E2E earns that phrase.
- ⚠ "Tamper-proof audit trail" — it's a **traceability** log, operator-visible;
  don't market it as an immutable ledger without extra hardening.

When in doubt, describe it as **"custodial, encrypted at rest"** — accurate, and it
won't come back to bite you in a compliance review.
