// IdentityClient — `/user/identity/*`: a user's avatar and display name,
// shared with other users only by explicit, revocable grant.
//
// Nothing is visible to anyone else until the owner shares it. Other users
// read identities live through `resolve()`, which re-checks the grant on
// every call and records the access; revoking a grant takes effect at once.

import type { HttpCore } from "./http.js";

export type IdentityFacet = "avatar" | "display_name";
export type IdentityAudience = "user" | "group" | "role" | "app_members";

export interface IdentityGrant {
  id: number;
  facet: string;
  audience_type: string;
  audience_ref: string;
  granted_at: number;
  expires_at: number | null;
}

export interface ResolvedIdentity {
  user_tid: string;
  username: string;
  /**
   * Facets this viewer may see. A missing key means "not set" OR "not
   * shared with you" — the two are deliberately indistinguishable.
   */
  facets: Partial<Record<IdentityFacet, string>>;
}

export interface IdentityAccessEntry {
  viewer_username: string | null;
  facet: string;
  action: "resolve" | "deny";
  granted: boolean;
  app_context: string | null;
  accessed_at: number;
}

export class IdentityClient {
  constructor(private readonly http: HttpCore) {}

  /** The caller's own facets. */
  async get(): Promise<Partial<Record<IdentityFacet, string>>> {
    const r = await this.http.post<{ facets: Partial<Record<IdentityFacet, string>> }>("/user/identity/get");
    return r.facets;
  }

  /**
   * Set a facet on yourself. `avatar` must be a `data:image/png|jpeg|webp;base64,`
   * URL of at most 96 KiB; `display_name` is 1–64 characters.
   * Errors: `facet_invalid`, `avatar_too_large`, `avatar_invalid`, `display_name_invalid`.
   */
  async set(facet: IdentityFacet, value: string): Promise<void> {
    await this.http.post("/user/identity/set", { facet, value });
  }

  /** Remove a facet from yourself; its active grants are revoked too. */
  async remove(facet: IdentityFacet): Promise<void> {
    await this.http.post("/user/identity/remove", { facet });
  }

  /**
   * Share one facet with an audience: a user tid, a group tid, a role tid,
   * or `app_members` with an app tid. Re-sharing the same target updates
   * `expiresAt` (epoch ms). Resolves the grant id.
   */
  async share(input: {
    facet: IdentityFacet;
    audienceType: IdentityAudience;
    audienceRef: string;
    expiresAt?: number;
  }): Promise<number> {
    const r = await this.http.post<{ grant_id: number }>("/user/identity/share", {
      facet: input.facet,
      audience_type: input.audienceType,
      audience_ref: input.audienceRef,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    });
    return r.grant_id;
  }

  /** Revoke a grant by id, or by its (facet, audience) triple. Resolves the count revoked. */
  async revoke(
    target: { grantId: number } | { facet: IdentityFacet; audienceType: IdentityAudience; audienceRef: string },
  ): Promise<number> {
    const body =
      "grantId" in target
        ? { grant_id: target.grantId }
        : { facet: target.facet, audience_type: target.audienceType, audience_ref: target.audienceRef };
    const r = await this.http.post<{ revoked: number }>("/user/identity/revoke", body);
    return r.revoked;
  }

  /** The caller's active grants, newest first. */
  async grants(): Promise<IdentityGrant[]> {
    const r = await this.http.post<{ grants: IdentityGrant[] }>("/user/identity/grants");
    return r.grants;
  }

  /**
   * Resolve other users' identities as the caller may see them (up to 300
   * users per call). Pass `appTid` when rendering inside an app so
   * `app_members` grants apply. `facets` defaults to both.
   */
  async resolve(input: { userTids: string[]; appTid?: string; facets?: IdentityFacet[] }): Promise<ResolvedIdentity[]> {
    const r = await this.http.post<{ identities: ResolvedIdentity[] }>("/user/identity/resolve", {
      user_tids: input.userTids,
      ...(input.appTid !== undefined ? { app_tid: input.appTid } : {}),
      ...(input.facets !== undefined ? { facets: input.facets } : {}),
    });
    return r.identities;
  }

  /** Who looked at your identity, newest first (`limit` 1–200, default 50). */
  async accessLog(input: { facet?: IdentityFacet; since?: number; limit?: number } = {}): Promise<IdentityAccessEntry[]> {
    const r = await this.http.post<{ log: IdentityAccessEntry[] }>("/user/identity/access-log", input);
    return r.log;
  }
}
