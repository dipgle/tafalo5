// LicenseClient — `/license`, `/licenses/*`, `/app/upgrade-license/*`.
// License tier catalog, usage, upgrade requests, and license token redemption.
// Note: admin-only endpoints (/admin/license/*) are NOT included here —
// those require platform-admin scope and belong in the operator SDK surface.

import type { HttpCore } from "./http.js";

// ============================================================
// License tier catalog
// ============================================================

/** One tier entry returned by `catalog()`. */
export interface LicenseTier {
  tid: string;
  name: string;
  description: string | null;
  user_max_apps: number;
  user_max_total_storage: number;
  app_max_storage: number;
  price_cents: number;
  billing_period: string;
  features: unknown[];
  self_service_max: boolean;
  display_order: number;
}

// ============================================================
// Current license + usage
// ============================================================

/** Per-user license summary within a `LicenseInfo` response. */
export interface UserLicenseSummary {
  tid: string;
  name: string | null;
  max_apps: number;
  max_total_storage: number;
}

/** Per-app license summary within a `LicenseInfo` response. */
export interface AppLicenseSummary {
  tid: string;
  name: string | null;
  max_storage_per_app: number;
}

/** Composite response from `get()`. */
export interface LicenseInfo {
  user: UserLicenseSummary;
  app: AppLicenseSummary;
  used: { apps: number; storage: number };
  remaining: {
    apps: number;
    storage: number;
    /** Only present when `app_tid` was passed. */
    storage_per_app?: number;
  };
}

// ============================================================
// Usage report (self-service dashboard)
// ============================================================

export interface AppUsageEntry {
  tid: string;
  name: string;
  license_tid: string;
  used_storage: number;
  app_max_storage: number;
}

/** Detailed usage response from `usage()`. */
export interface UsageReport {
  user: {
    tid: string;
    license_tid: string;
    license_name: string | null;
    app_count: number;
    max_apps: number;
    used_storage: number;
    max_total_storage: number;
    app_max_storage: number;
  };
  apps: AppUsageEntry[];
}

// ============================================================
// Upgrade preview
// ============================================================

export interface UserUpgradePreview {
  target: "user";
  current: {
    license_tid: string;
    license_name: string | null;
    max_apps: number;
    max_total_storage: number;
    app_max_storage: number;
    app_count: number;
    used_storage: number;
  };
  after: {
    license_tid: string;
    license_name: string;
    max_apps: number;
    max_total_storage: number;
    app_max_storage: number;
  };
  delta: { apps: number; storage: number; app_max_storage: number };
}

export interface AppUpgradePreview {
  target: "app";
  app_tid: string;
  current: {
    license_tid: string;
    license_name: string | null;
    app_max_storage: number;
    used_storage: number;
  };
  after: { license_tid: string; license_name: string; app_max_storage: number };
  delta: { app_max_storage: number };
}

export type UpgradePreview = UserUpgradePreview | AppUpgradePreview;

// ============================================================
// Upgrade request flow
// ============================================================

export interface LicenseRequest {
  tid: string;
  app_tid: string;
  target: "app" | "user";
  target_tid: string;
  requested_tier: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requester_tid: string;
  reason: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  created_at: number;
}

// ============================================================
// License token (redeem)
// ============================================================

/** One token entry returned by `myTokens()`. */
export interface LicenseTokenEntry {
  token_hash: string;
  plan: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  redeemed_at: number | null;
}

// ============================================================
// Client
// ============================================================

/**
 * LicenseClient — wraps all license-related endpoints.
 *
 * `/license` and `/licenses/*` have no app scope (user-level).
 * `/app/upgrade-license/*` endpoints are app-scoped: `http` auto-injects
 * `app_tid` from `useApp()`.
 */
export class LicenseClient {
  constructor(private readonly http: HttpCore) {}

  // ------------------------------------------------------------------
  // Current license status
  // ------------------------------------------------------------------

  /**
   * Return the caller's current license tier, usage, and headroom.
   * Pass an `appTid` to include per-app storage remaining.
   * No app scope — called as a user-level endpoint.
   */
  get(appTid?: string): Promise<LicenseInfo> {
    return this.http.post<LicenseInfo>("/license", appTid ? { app_tid: appTid } : {});
  }

  // ------------------------------------------------------------------
  // Catalog + usage + preview (no app scope)
  // ------------------------------------------------------------------

  /**
   * Fetch the publicly visible license tier catalog.
   * Anonymous-friendly — no auth required. Used by pricing/marketing pages.
   */
  catalog(): Promise<{ tiers: LicenseTier[] }> {
    return this.http.post<{ tiers: LicenseTier[] }>("/licenses/catalog", {});
  }

  /**
   * Return the caller's detailed usage: tier limits, app count, storage,
   * and a per-app breakdown. Authenticated.
   */
  usage(): Promise<UsageReport> {
    return this.http.post<UsageReport>("/licenses/usage", {});
  }

  /**
   * Dry-run an upgrade to see the before/after deltas without committing.
   * Pass `target: "user"` for a user-level upgrade or `target: "app"` with
   * `appTid` for a per-app upgrade.
   */
  previewUpgrade(
    target: "user" | "app",
    requestedTier: string,
    appTid?: string,
  ): Promise<UpgradePreview> {
    return this.http.post<UpgradePreview>("/licenses/preview-upgrade", {
      target,
      requested_tier: requestedTier,
      ...(appTid ? { app_tid: appTid } : {}),
    });
  }

  // ------------------------------------------------------------------
  // License token — user-facing redeem + listing (no app scope)
  // ------------------------------------------------------------------

  /**
   * Redeem a license token. The token must have been issued to the
   * caller's `user_tid`, must not be expired/revoked/already-redeemed,
   * and its `plan` must reference an existing tier in `licenses`.
   * On success, `users.license_tid` is flipped to the plan name
   * immediately — no restart required.
   *
   * For services and plans sold through billing, the newer entitlement
   * tokens are redeemed with `tfl5.billing.redeem()`.
   */
  redeem(token: string): Promise<{ plan: string }> {
    return this.http.post<{ plan: string }>("/license/redeem", { token });
  }

  /**
   * List the caller's own license tokens (issued + redemption + revocation
   * timestamps). Useful for a "My Plan" settings panel.
   */
  async myTokens(): Promise<LicenseTokenEntry[]> {
    const r = await this.http.post<{ tokens: LicenseTokenEntry[] }>("/license/my-tokens", {});
    return r.tokens;
  }

  // ------------------------------------------------------------------
  // Upgrade request flow (app-scoped)
  // ------------------------------------------------------------------

  /**
   * File an upgrade request with the operator.
   * `target` is `"app"` (upgrade the app's per-app tier) or `"user"`
   * (upgrade the user's account tier). Requires Manager on the app.
   * Idempotent — re-filing while a pending request exists returns an error.
   */
  requestUpgrade(
    target: "app" | "user",
    requestedTier: string,
    reason?: string,
  ): Promise<{ tid: string; status: "pending" }> {
    return this.http.post("/app/upgrade-license", {
      target,
      requested_tier: requestedTier,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * List upgrade requests filed from the current app (tenant view).
   * Reader permission is sufficient.
   */
  listUpgradeRequests(): Promise<LicenseRequest[]> {
    return this.http.post<LicenseRequest[]>("/app/upgrade-license/list", {});
  }

  /**
   * First-run setup on a self-hosted install: the platform's first user
   * picks their own account tier, up to the highest self-service tier.
   * Omit `wantedUserTier` to read the current tier (`noop: true`).
   * Errors: `not_first_user`, `tier_not_found`,
   * `license_tier_not_self_service`, `no_self_service_tier`.
   */
  setupTenant(wantedUserTier?: string): Promise<{
    noop?: boolean;
    current_tier?: string;
    reason?: string;
    upgraded?: boolean;
    from?: string;
    to?: string;
  }> {
    return this.http.post(
      "/licenses/setup-tenant",
      wantedUserTier !== undefined ? { wanted_user_tier: wantedUserTier } : {},
    );
  }

  /**
   * Cancel a pending upgrade request filed from the current app.
   * Requires Manager permission.
   */
  cancelUpgradeRequest(tid: string): Promise<void> {
    return this.http
      .post("/app/upgrade-license/cancel", { tid })
      .then(() => undefined);
  }
}
