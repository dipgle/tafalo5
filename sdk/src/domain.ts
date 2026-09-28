// DomainClient — `/app/domain/*`. Custom domain binding, DNS verification,
// and subdomain delegation.

import type { HttpCore } from "./http.js";

// ============================================================
// Domain records
// ============================================================

/** A custom domain row returned by `list()`. */
export interface DomainRecord {
  tid: string;
  domain: string;
  active: boolean;
  badge: "live" | "warming" | "needs_recheck";
  verified_at: number | null;
  first_served_at: number | null;
  last_recheck: number | null;
  consecutive_failures: number;
  created_at: number;
  /** DNS instructions for inactive rows only. */
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

/** Response from `preview()` for a domain that needs DNS verification. */
export interface DomainPreviewResult {
  domain: string;
  app_tid?: string;
  /** True when DNS can be skipped (local-dev / subdomain shortcut / delegation). */
  auto_active?: boolean;
  /** Present when `auto_active` is true via the subdomain-owner shortcut. */
  shortcut?: { parent_app_tid: string; parent_domain: string };
  /** Present when `auto_active` is true via a delegation grant. */
  delegation?: {
    parent_app_tid: string;
    parent_domain: string;
    delegation_tid: string | null;
  };
  /** DNS instructions to show to the user when verification is required. */
  verify?: DnsInstructions;
  already_owned?: boolean;
  note?: string;
}

/** Response from `add()`. */
export interface DomainAddResult {
  tid: string;
  domain: string;
  app_tid: string;
  active: boolean;
  method?: "a" | "subdomain-shortcut" | "subdomain-delegated";
  already?: boolean;
  parent?: { app_tid: string; domain: string };
  delegation_tid?: string | null;
  warnings?: string[];
}

// ============================================================
// Delegation — parent-owner configuration
// ============================================================

export interface DelegationConfig {
  domain: string;
  /** `"private"` (default) or `"public"`. */
  mode: "private" | "public";
  label_rules: { allow: string[]; deny: string[] };
  whitelist_count: number;
  /** Constant fail-safe ruleset for first-time public mode. */
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

// ============================================================
// Delegation — access-request flow
// ============================================================

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

// ============================================================
// Client
// ============================================================

/**
 * DomainClient — wraps all `/app/domain/*` endpoints.
 *
 * Core domain operations (`preview`, `add`, `list`, `del`, `verify`) are
 * app-scoped: `http` auto-injects `app_tid` from `useApp()`.
 *
 * Delegation management methods are grouped at the bottom and require the
 * caller to be the **owner** of the parent app.
 */
export class DomainClient {
  constructor(private readonly http: HttpCore) {}

  // ------------------------------------------------------------------
  // Core domain operations
  // ------------------------------------------------------------------

  /**
   * Mint DNS instructions for a domain — no DB write. Requires Manager
   * permission (was Owner until 2026-08-17).
   * Returns `auto_active: true` when DNS verification can be skipped
   * (local-dev host / subdomain shortcut / delegation grant), and — since
   * 2026-08-17 — also when the proof is ALREADY in DNS: the A record points
   * here or the TXT token is published. In that case `proof_already_in_dns`
   * says which one, and `add()` can be called straight away.
   */
  preview(domain: string): Promise<DomainPreviewResult> {
    return this.http.post<DomainPreviewResult>("/app/domain/preview", { domain });
  }

  /**
   * Verify domain ownership and bind it to the app. Requires Manager
   * permission (was Owner until 2026-08-17); removing one still needs Owner.
   * For public hosts, the domain's A record must already point at this server.
   * For local-dev (`*.localhost`), subdomain shortcuts, and delegations the
   * verification step is skipped automatically.
   */
  async add(domain: string): Promise<DomainAddResult> {
    const env = await this.http.postEnvelope<{ data: DomainAddResult; warnings?: string[] }>(
      "/app/domain/add",
      { domain },
    );
    return env.warnings ? { ...env.data, warnings: env.warnings } : env.data;
  }

  /** List all custom domains bound to the app (Designer+ permission). */
  list(): Promise<DomainRecord[]> {
    return this.http.post<DomainRecord[]>("/app/domain/list", {});
  }

  /** Remove a domain binding by its `tid`. Requires Owner permission. */
  del(tid: string): Promise<void> {
    return this.http.post("/app/domain/del", { tid }).then(() => undefined);
  }

  /**
   * Re-check DNS and re-activate an inactive domain row.
   * Accepts both the new A-record method and the legacy TXT-token method.
   */
  verify(tid: string): Promise<DomainAddResult> {
    return this.http.post<DomainAddResult>("/app/domain/verify", { tid });
  }

  // ------------------------------------------------------------------
  // Delegation — parent-owner configuration
  // ------------------------------------------------------------------

  /**
   * Toggle the delegation mode for a parent domain.
   * `mode` must be `"private"` (default, explicit whitelist required) or
   * `"public"` (any authenticated user may bind subs; label rules still apply).
   * First flip to public auto-populates fail-safe default label rules.
   */
  setMode(
    domain: string,
    mode: "private" | "public",
  ): Promise<{ domain: string; mode: string; auto_populated_default_rules: boolean }> {
    return this.http.post("/app/domain/mode", { domain, mode });
  }

  /**
   * Replace the `allow` / `deny` regex label-rule sets for a parent domain.
   * Patterns target the sub-prefix (everything before `.<parent>`).
   * Max 10 patterns per list, max 200 chars each. Pass empty arrays to clear.
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
   * Read the current delegation config (mode + label rules + whitelist count)
   * for a parent domain. Owner only.
   */
  getConfig(domain: string): Promise<DelegationConfig> {
    return this.http.post<DelegationConfig>("/app/domain/get-config", { domain });
  }

  /**
   * Dry-run a candidate `allow`/`deny` ruleset against a single label without
   * persisting anything. Returns `verdict`, `matched_pattern`, and `reason`.
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
   * Grant `grantee_user_tid` the right to bind subdomains under `domain`.
   * Re-granting rotates `expires_at` + `max_subs` atomically (upsert).
   * Pass `max_subs: null` to lift an existing per-grantee cap.
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
   * Revoke a delegation grant for `grantee_user_tid` under `domain`.
   * Existing subdomains bound by the grantee are NOT removed.
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

  /** List all whitelist (delegation) grants for a parent domain. Owner only. */
  whitelistList(domain: string): Promise<WhitelistEntry[]> {
    return this.http.post<WhitelistEntry[]>("/app/domain/whitelist/list", { domain });
  }

  // ------------------------------------------------------------------
  // Delegation — grantee-side view
  // ------------------------------------------------------------------

  /**
   * List all parents the *caller* can bind subdomains under — both explicit
   * whitelist grants and public-mode parents. No `app_tid` needed.
   */
  delegationsReceived(): Promise<ReceivedDelegation[]> {
    return this.http.post<ReceivedDelegation[]>("/app/domain/delegations/received", {});
  }

  // ------------------------------------------------------------------
  // Delegation — parent admin utilities
  // ------------------------------------------------------------------

  /**
   * Force-unbind a subdomain from whatever app currently holds it.
   * The caller must own the parent app whose active domain is the
   * longest-suffix ancestor of `subDomain`.
   * `adminAppTid` is the caller's own app (used for auth only).
   */
  reclaimSub(
    adminAppTid: string,
    subDomain: string,
    reason?: string,
  ): Promise<{
    sub_domain: string;
    parent_domain: string;
    reclaimed_from_app_tid: string;
  }> {
    return this.http.post("/app/domain/reclaim-sub", {
      admin_app_tid: adminAppTid,
      sub_domain: subDomain,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * List every active subdomain currently bound under `domain`.
   * Shows the app name + owner for each sub so the owner knows what they
   * would reclaim. Owner only.
   */
  subsOfParent(domain: string): Promise<SubDomainEntry[]> {
    return this.http.post<SubDomainEntry[]>("/app/domain/subs-of-parent", { domain });
  }

  // ------------------------------------------------------------------
  // Delegation — access-request flow
  // ------------------------------------------------------------------

  /**
   * File a request to bind `domain` (a sub of a private parent).
   * Only valid when `evaluate_delegation` returns `private_needs_request`.
   * Idempotent — re-submitting a still-pending request returns the
   * existing row with `already_pending: true`.
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
   * Cancel a pending access request the caller filed.
   * `requestTid` is the `tid` from `requestAccess()`.
   */
  cancelRequest(requestTid: string): Promise<void> {
    return this.http
      .post("/app/domain/request/cancel", { request_tid: requestTid })
      .then(() => undefined);
  }

  /** List all access requests the *caller* has filed (own view). */
  myRequests(): Promise<DomainBindRequest[]> {
    return this.http.post<DomainBindRequest[]>("/app/domain/requests/mine", {});
  }

  /**
   * List pending access requests received for `domain` (parent-owner view).
   * Shows requester username for display. Owner only.
   */
  requestsReceived(domain: string): Promise<ReceivedBindRequest[]> {
    return this.http.post<ReceivedBindRequest[]>("/app/domain/requests/received", { domain });
  }

  /**
   * Approve a pending access request and mint a delegation grant.
   * Optionally set `max_subs` and `expires_at` on the resulting grant.
   * Owner only.
   */
  approveRequest(
    domain: string,
    requestTid: string,
    opts: { max_subs?: number; expires_at?: number } = {},
  ): Promise<{
    request_tid: string;
    delegation_tid: string;
    grantee_user_tid: string;
  }> {
    return this.http.post("/app/domain/request/approve", {
      domain,
      request_tid: requestTid,
      ...opts,
    });
  }

  /**
   * Deny a pending access request. Owner only.
   * `requestTid` is the `tid` from `requestsReceived()`.
   */
  denyRequest(domain: string, requestTid: string): Promise<void> {
    return this.http
      .post("/app/domain/request/deny", { domain, request_tid: requestTid })
      .then(() => undefined);
  }
}
