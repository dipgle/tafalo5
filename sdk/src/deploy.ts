// BundleClient — `/app/bundle/*`. Versioned static-asset (FE) bundles.
// DomainClient — `/app/domain/*`. Custom domain binding, DNS verification,
// and subdomain delegation.
//
// Both clients are app-scoped: `http.post` auto-injects `app_tid` from
// `useApp()` unless a call already carries one, so no method below takes an
// explicit `appTid` parameter (the two exceptions — `reclaimSub`'s
// `adminAppTid` and the request-flow's own `app_tid` semantics — use a
// DIFFERENT field name than `app_tid` and so are spelled out explicitly).
//
// Source of truth read for this file: crates/routes/src/bundle.rs,
// crates/routes/src/domain.rs, crates/routes/src/domain_delegation.rs.

import type { HttpCore } from "./http.js";

// ====================================================================
// BundleClient — versioned FE bundles
// ====================================================================

/** One uploaded bundle version, as returned by `list()`. */
export interface BundleVersion {
  tid: string;
  version: string;
  sha256: string;
  file_count: number;
  total_bytes: number;
  uploaded_by: string;
  uploaded_at: number;
  notes?: string | null;
  is_current: boolean;
  is_previous: boolean;
}

/** Response from `upload()` (bundle.rs:273-286). */
export interface BundleUploadResult {
  tid: string;
  app_tid: string;
  version: string;
  sha256: string;
  file_count: number;
  total_bytes: number;
  uploaded_at: number;
  original_filename?: string | null;
}

/** Response from `activate()` (bundle.rs:426-434). */
export interface BundleActivateResult {
  app_tid: string;
  current_bundle_version: string | null;
  previous_bundle_version: string | null;
}

/** Response from `rollback()` (bundle.rs:487-495). */
export interface BundleRollbackResult {
  app_tid: string;
  current_bundle_version: string | null;
  previous_bundle_version: string | null;
}

/** Response from `unpublish()` (bundle.rs:552-559). */
export interface BundleUnpublishResult {
  app_tid: string;
  current_bundle_version: null;
  previous_bundle_version: string | null;
}

/**
 * Returned by `list()`.
 *
 * The server also emits `current_bundle_version` / `previous_bundle_version`
 * as top-level envelope siblings of `data` (bundle.rs:627-633). The
 * transport only unwraps `data`, so those two siblings are NOT visible here
 * — read `.is_current` / `.is_previous` per entry instead.
 */
export type BundleListResult = BundleVersion[];

/**
 * Manages versioned bundle uploads and activation for the scoped app.
 *
 * A bundle is the static FE asset tree (html/js/css/images) for a release.
 * Bytes are quota-free (don't count against `apps.used_storage`) and entries
 * are ACL-free (gated only by "is this the app's current bundle?").
 *
 * NOTE — bundles are one of several serve tiers. `crates/routes/src/
 * public.rs:294-331` resolves, in order: content-addressed `live_snapshot`
 * (see `SiteClient`/`snapshot.rs`) FIRST, then `current_bundle_version`
 * (this client), then the legacy `current_release_version` / `public/`
 * tree. A file you activate here can be silently shadowed if the app has
 * ever been published onto a site-engine snapshot.
 */
export class BundleClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload a zip archive as a new immutable bundle version.
   *
   * Multipart fields: `app_tid` (auto-injected), `version`, `notes?`,
   * `file` (the zip). Field order does not matter — the handler matches by
   * field name (bundle.rs:96-149). Server caps: the zip itself ≤ 10 MB
   * (`MAX_UPLOAD_BYTES`), ≤ 500 entries (`MAX_BUNDLE_ENTRIES`), and ≤ 50 MB
   * total uncompressed (`MAX_BUNDLE_UNCOMPRESSED_BYTES`) — see
   * `crates/routes/src/file/mod.rs:72,80,81`. `version` must be
   * alphanumeric + `. _ -`, ≤ 64 chars, and unique per app — re-uploading an
   * existing version throws with `.code === "bundle_version_exists"`.
   * Requires Manager.
   */
  upload(
    input: FormData | { version: string; notes?: string; file: Blob | File },
  ): Promise<BundleUploadResult> {
    let form: FormData;
    if (input instanceof FormData) {
      form = input;
    } else {
      form = new FormData();
      form.append("version", input.version);
      if (input.notes != null) form.append("notes", input.notes);
      const filename = input.file instanceof File ? input.file.name : "bundle.zip";
      form.append("file", input.file, filename);
    }
    return this.http.postForm<BundleUploadResult>("/app/bundle/upload", form);
  }

  /**
   * Atomically flip `apps.current_bundle_version` to `version`.
   * The previous active version is stashed for one-click `rollback()`.
   * Throws with `.code === "bundle_version_not_found"` if `version` was
   * never uploaded for this app. Requires Manager.
   */
  activate(version: string): Promise<BundleActivateResult> {
    return this.http.post<BundleActivateResult>("/app/bundle/activate", { version });
  }

  /**
   * Swap `current_bundle_version` ↔ `previous_bundle_version`.
   * Throws with `.code === "bundle_no_previous"` if there is nothing to
   * roll back to. Requires Manager.
   */
  rollback(): Promise<BundleRollbackResult> {
    return this.http.post<BundleRollbackResult>("/app/bundle/rollback", {});
  }

  /**
   * Take the site offline by NULLing `current_bundle_version` (stashed as
   * `previous`, so `rollback()` or a fresh `activate()` republishes it).
   * Idempotent — double-unpublish keeps the earlier `previous`
   * (bundle.rs:524-526). Requires Manager.
   */
  unpublish(): Promise<BundleUnpublishResult> {
    return this.http.post<BundleUnpublishResult>("/app/bundle/unpublish", {});
  }

  /**
   * List bundle versions for the app, newest first. Requires Reader.
   * @param limit Default 20, clamped server-side to 1-200.
   */
  list(limit?: number): Promise<BundleListResult> {
    return this.http.post<BundleListResult>("/app/bundle/list", limit != null ? { limit } : {});
  }
}

// ====================================================================
// DomainClient — custom domains + delegation
// ====================================================================

/** A custom domain row returned by `list()`. */
export interface DomainRecord {
  tid: string;
  domain: string;
  active: boolean;
  /** Derived: `!active` -> "needs_recheck"; `active` + served once ->
   *  "live"; `active` + never served -> "warming" (domain.rs:1108-1118). */
  badge: "live" | "warming" | "needs_recheck";
  verified_at: number | null;
  first_served_at: number | null;
  last_recheck: number | null;
  consecutive_failures: number;
  created_at: number;
  /** DNS instructions, present only for inactive rows. */
  verify?: DnsInstructions;
}

export interface DnsRecord {
  type: "A" | "TXT";
  host: string;
  value: string;
  note: string;
}

export interface DnsInstructions {
  verify_token: string;
  records: DnsRecord[];
  note: string;
}

/**
 * Response from `preview()`.
 *
 * `preview()`/`add()` reply with HTTP 200 + `{result:false, msg, code?}` for
 * expected "soft" rejections (invalid host, domain owned by another app,
 * delegation deny) rather than a 4xx — the transport still throws (see
 * `HttpCore.unwrap`'s `env.result === false` branch), surfacing as a
 * `Tfl5Error` whose `.code` is one of `"private_needs_request"` /
 * `"label_denied"` / `"quota_reached"` (delegation gate, domain_
 * delegation.rs:499-567) or absent (generic validation) — inspect it to
 * decide whether to offer a "Request access" action.
 */
export interface DomainPreviewResult {
  domain: string;
  app_tid?: string;
  /** True when DNS can be skipped (local-dev / subdomain shortcut / delegation). */
  auto_active?: boolean;
  /** Local-dev (`*.localhost`) branch ONLY: always `""` — no real token is
   *  minted since DNS is skipped entirely (domain.rs:473-482). */
  verify_token?: string;
  /** Present when `auto_active` is true via the subdomain-owner shortcut. */
  shortcut?: { parent_app_tid: string; parent_domain: string };
  /** Present when `auto_active` is true via a delegation grant. */
  delegation?: { parent_app_tid: string; parent_domain: string; delegation_tid: string | null };
  /** DNS instructions to show the user when verification is required. */
  verify?: DnsInstructions;
  already_owned?: boolean;
  note?: string;
}

/** Response from `add()` (domain.rs:727-945). Always carries `app_tid`. */
export interface DomainAddResult {
  tid: string;
  domain: string;
  app_tid: string;
  active: boolean;
  method?: "a" | "subdomain-shortcut" | "subdomain-delegated";
  already?: boolean;
  parent?: { app_tid: string; domain: string };
  delegation_tid?: string | null;
  /** Always `[]` today — kept for wire-shape back-compat (domain.rs:933). */
  warnings?: string[];
}

/**
 * Response from `verify()` (domain.rs:1257-1385). Unlike `DomainAddResult`,
 * this NEVER carries `app_tid` (the handler's JSON simply omits it on every
 * branch) and `method` can additionally be `"txt"` for a legacy TXT-token
 * recheck.
 */
export interface DomainVerifyResult {
  tid: string;
  domain: string;
  active: boolean;
  method?: "txt" | "a" | "subdomain-shortcut";
  already?: boolean;
}

// ---- Delegation — parent-owner configuration ----

export interface DelegationConfig {
  domain: string;
  /** `"private"` (default) or `"public"`. */
  mode: "private" | "public";
  label_rules: { allow: string[]; deny: string[] };
  whitelist_count: number;
  /** Constant fail-safe ruleset auto-applied on first-time public mode. */
  public_default_rules: { allow: string[]; deny: string[] };
}

export interface WhitelistEntry {
  tid: string;
  grantee_user_tid: string;
  granted_by: string;
  conditions: Record<string, unknown>;
  max_subs: number | null;
  expires_at: number | null;
  created_at: number;
}

/** Entry returned by `delegationsReceived()` — what the caller can bind under. */
export interface ReceivedDelegation {
  parent_domain: string;
  via: "whitelist" | "public";
  /** Only present for `via: "whitelist"` rows. */
  expires_at?: number | null;
  label_rules: { allow: string[]; deny: string[] };
}

/** A sub domain currently bound under a parent. Returned by `subsOfParent()`. */
export interface SubDomainEntry {
  tid: string;
  domain: string;
  app_tid: string;
  app_name: string;
  app_owner: string;
  active: boolean;
  created_at: number;
}

export interface TestPatternResult {
  verdict: "allow" | "deny" | "no-allow-match";
  matched_pattern: string | null;
  reason: string;
}

// ---- Delegation — access-request flow ----

export interface DomainBindRequest {
  tid: string;
  parent_domain: string;
  requested_host: string;
  app_tid: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  note: string | null;
  created_at: number;
  decided_at: number | null;
  delegation_tid: string | null;
}

/** Incoming request visible to the parent owner via `requestsReceived()`. */
export interface ReceivedBindRequest {
  tid: string;
  requested_host: string;
  requester_user_tid: string;
  requester_username: string | null;
  app_tid: string;
  note: string | null;
  created_at: number;
}

/**
 * DomainClient — wraps all `/app/domain/*` endpoints (21 total: 5 core +
 * 16 delegation, split across `domain.rs` and `domain_delegation.rs`).
 *
 * Perm levels (Batch 45 hardening): `preview`/`add`/`del`/`verify` and every
 * delegation-config/whitelist/request-approval method require **Owner**
 * (`apps.author` — being a Manager is not enough); `list()` only requires
 * Designer. `delegationsReceived()` / `myRequests()` / `cancelRequest()`
 * need no app perm at all — they're scoped to the logged-in caller's own
 * session (and require the caller's email to be verified).
 */
export class DomainClient {
  constructor(private readonly http: HttpCore) {}

  // ------------------------------------------------------------------
  // Core domain operations
  // ------------------------------------------------------------------

  /**
   * Mint DNS instructions for a domain — no DB write. Requires Owner.
   * Returns `auto_active: true` when DNS verification can be skipped
   * (local-dev host / subdomain shortcut / delegation grant) — see
   * `DomainPreviewResult` for the soft-rejection / error-code contract.
   */
  preview(domain: string): Promise<DomainPreviewResult> {
    return this.http.post<DomainPreviewResult>("/app/domain/preview", { domain });
  }

  /**
   * Verify domain ownership and bind it to the app. Requires Owner.
   * For public hosts, the domain's A record must already point at this
   * server (there is no TXT/token dance on `/add` — see domain.rs:648-652).
   * Local-dev, subdomain-shortcut, and delegation hosts skip verification.
   * On the "A record not found" rejection, the thrown error's
   * `.body.data` carries `{domain, expected_a_target}` (domain.rs:907-915).
   */
  add(domain: string): Promise<DomainAddResult> {
    return this.http.post<DomainAddResult>("/app/domain/add", { domain });
  }

  /** List all custom domains bound to the app. Requires Designer. */
  list(): Promise<DomainRecord[]> {
    return this.http.post<DomainRecord[]>("/app/domain/list", {});
  }

  /** Remove a domain binding by its `tid`. Requires Owner. Throws NotFound
   *  if `tid` doesn't belong to this app (never silently no-ops). */
  del(tid: string): Promise<void> {
    return this.http.post("/app/domain/del", { tid }).then(() => undefined);
  }

  /**
   * Re-check DNS and re-activate an inactive domain row. Requires Owner.
   * Tries a freshly-derived HMAC token first, then the row's legacy stored
   * token (for rows created under the old pending-token flow), accepting
   * either TXT or A proof. See `DomainVerifyResult` for the response shape
   * (notably: no `app_tid`, and `method` can be `"txt"`).
   */
  verify(tid: string): Promise<DomainVerifyResult> {
    return this.http.post<DomainVerifyResult>("/app/domain/verify", { tid });
  }

  // ------------------------------------------------------------------
  // Delegation — parent-owner configuration
  // ------------------------------------------------------------------

  /**
   * Toggle the delegation mode for a parent domain the caller owns.
   * `mode` must be `"private"` (default, explicit whitelist required) or
   * `"public"` (any authenticated + email-verified user may bind subs;
   * label rules still apply). First flip to public auto-populates
   * fail-safe default label rules UNLESS the owner already has rules set.
   * Requires Owner of the app that owns `domain`.
   */
  setMode(
    domain: string,
    mode: "private" | "public",
  ): Promise<{ domain: string; mode: string; auto_populated_default_rules: boolean }> {
    return this.http.post("/app/domain/mode", { domain, mode });
  }

  /**
   * Replace the `allow` / `deny` regex label-rule sets for a parent domain.
   * Patterns target the sub-prefix (everything before `.<parent>`). Max 10
   * patterns per list, max 200 chars each — an invalid pattern throws with
   * `.code === "invalid_regex"`. Pass empty arrays to clear. Requires Owner.
   */
  setLabelRules(
    domain: string,
    rules: { allow: string[]; deny: string[] },
  ): Promise<{ domain: string; allow_count: number; deny_count: number }> {
    return this.http.post("/app/domain/label-rules", {
      domain,
      allow: rules.allow,
      deny: rules.deny,
    });
  }

  /**
   * Read the current delegation config (mode + label rules + whitelist
   * count + the constant public-mode default rules) for a parent domain.
   * Requires Owner.
   */
  getConfig(domain: string): Promise<DelegationConfig> {
    return this.http.post<DelegationConfig>("/app/domain/get-config", { domain });
  }

  /**
   * Dry-run a candidate `allow`/`deny` ruleset against a single label
   * without persisting anything or touching the compiled-rules cache.
   * `label` must be a single DNS label (no dots). Requires Owner.
   */
  testPattern(
    domain: string,
    label: string,
    rules: { allow: string[]; deny: string[] },
  ): Promise<TestPatternResult> {
    return this.http.post<TestPatternResult>("/app/domain/delegation/test-pattern", {
      domain,
      label,
      allow: rules.allow,
      deny: rules.deny,
    });
  }

  // ------------------------------------------------------------------
  // Delegation — whitelist management (parent owner)
  // ------------------------------------------------------------------

  /**
   * Grant `granteeUserTid` the right to bind subdomains under `domain`.
   * Re-granting rotates `expires_at` + `max_subs` atomically (upsert on
   * `(parent_domain, grantee_user_tid)`). Pass `max_subs: null` (or omit)
   * to lift/leave unlimited; `max_subs` must be >= 1 if given. Rejects
   * granting the parent owner themselves. Requires Owner.
   */
  whitelistAdd(
    domain: string,
    granteeUserTid: string,
    opts: { expires_at?: number | null; max_subs?: number | null } = {},
  ): Promise<{
    tid: string;
    parent_domain: string;
    grantee_user_tid: string;
    expires_at: number | null;
    max_subs: number | null;
  }> {
    return this.http.post("/app/domain/whitelist/add", {
      domain,
      grantee_user_tid: granteeUserTid,
      ...opts,
    });
  }

  /**
   * Revoke a delegation grant for `granteeUserTid` under `domain`.
   * Existing subdomains the grantee already bound are NOT removed.
   * Requires Owner.
   */
  whitelistRemove(
    domain: string,
    granteeUserTid: string,
  ): Promise<{ parent_domain: string; removed_tid: string | null; existing_subs_kept: boolean }> {
    return this.http.post("/app/domain/whitelist/remove", {
      domain,
      grantee_user_tid: granteeUserTid,
    });
  }

  /** List all whitelist (delegation) grants for a parent domain. Requires Owner. */
  whitelistList(domain: string): Promise<WhitelistEntry[]> {
    return this.http.post<WhitelistEntry[]>("/app/domain/whitelist/list", { domain });
  }

  // ------------------------------------------------------------------
  // Delegation — grantee-side view
  // ------------------------------------------------------------------

  /**
   * List every parent domain the *caller* (from session, not `app_tid`) may
   * bind subdomains under — both explicit whitelist grants and public-mode
   * parents. No app scope needed. Requires the caller's email to be
   * verified; throws Unauthorized otherwise.
   */
  delegationsReceived(): Promise<ReceivedDelegation[]> {
    return this.http.post<ReceivedDelegation[]>("/app/domain/delegations/received", {});
  }

  // ------------------------------------------------------------------
  // Delegation — parent admin utilities
  // ------------------------------------------------------------------

  /**
   * Force-unbind a subdomain from whatever app currently holds it.
   * `adminAppTid` is the CALLER'S OWN app — used only to resolve their
   * identity/perm, NOT auto-injected as `app_tid` (this endpoint has no
   * `app_tid` field at all). The real authorization check is that the
   * caller owns the app bound to the STRICT longest-suffix parent of
   * `subDomain` (the sub itself is excluded from the parent search).
   */
  reclaimSub(
    adminAppTid: string,
    subDomain: string,
    reason?: string,
  ): Promise<{ sub_domain: string; parent_domain: string; reclaimed_from_app_tid: string }> {
    return this.http.post("/app/domain/reclaim-sub", {
      admin_app_tid: adminAppTid,
      sub_domain: subDomain,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * List every active subdomain currently bound under `domain` (the parent
   * row itself is excluded). Shows the app name + owner so the owner knows
   * what `reclaimSub()` would take. Requires Owner.
   */
  subsOfParent(domain: string): Promise<SubDomainEntry[]> {
    return this.http.post<SubDomainEntry[]>("/app/domain/subs-of-parent", { domain });
  }

  // ------------------------------------------------------------------
  // Delegation — access-request flow
  // ------------------------------------------------------------------

  /**
   * File a request to bind `domain` (a sub of a PRIVATE parent the caller
   * has no whitelist grant for). Only valid when the delegation gate would
   * otherwise deny with `.code === "private_needs_request"` — any other
   * outcome (already allowed / not a private parent / label-denied /
   * quota-reached) throws BadRequest instead. Idempotent: re-submitting a
   * still-pending request returns the existing row with
   * `already_pending: true`. Requires Owner of `app_tid` (the app the sub
   * will be bound to) + a verified email.
   */
  requestAccess(
    domain: string,
    note?: string,
  ): Promise<{
    tid: string;
    parent_domain: string;
    requested_host: string;
    status: "pending";
    already_pending: boolean;
  }> {
    return this.http.post("/app/domain/request", {
      domain,
      ...(note !== undefined ? { note } : {}),
    });
  }

  /**
   * Cancel a pending access request the caller filed. `requestTid` is the
   * `tid` from `requestAccess()`. Session-scoped (no app perm needed) —
   * only the original requester may cancel their own row.
   */
  cancelRequest(requestTid: string): Promise<void> {
    return this.http.post("/app/domain/request/cancel", { request_tid: requestTid }).then(() => undefined);
  }

  /** List all access requests the *caller* has filed (own view, session-scoped). */
  myRequests(): Promise<DomainBindRequest[]> {
    return this.http.post<DomainBindRequest[]>("/app/domain/requests/mine", {});
  }

  /**
   * List pending access requests received for `domain` (parent-owner view).
   * Requires Owner.
   */
  requestsReceived(domain: string): Promise<ReceivedBindRequest[]> {
    return this.http.post<ReceivedBindRequest[]>("/app/domain/requests/received", { domain });
  }

  /**
   * Approve a pending access request — mints (or rotates) the same kind of
   * `domain_delegations` grant `whitelistAdd()` would, then marks the
   * request `approved`. `max_subs` must be >= 1 if given. Requires Owner.
   */
  approveRequest(
    domain: string,
    requestTid: string,
    opts: { max_subs?: number; expires_at?: number } = {},
  ): Promise<{ request_tid: string; delegation_tid: string; grantee_user_tid: string }> {
    return this.http.post("/app/domain/request/approve", {
      domain,
      request_tid: requestTid,
      ...opts,
    });
  }

  /** Deny a pending access request. Requires Owner. */
  denyRequest(domain: string, requestTid: string): Promise<void> {
    return this.http
      .post("/app/domain/request/deny", { domain, request_tid: requestTid })
      .then(() => undefined);
  }
}
