// SharesClient — `/app/share/*`. Per-doc grants + anonymous link claim.

import type { HttpCore } from "./http.js";

export interface CreateShareInput {
  doc_tid: string;
  /**
   * Who receives the grant: a user id (`u-…`), a group id (`g-…`), a role
   * token (`[r-…]`), `G_author` (every signed-in user) or `anonymous` (the
   * response then carries a random `token` to hand out as a share link).
   */
  target: string;
  /** Restrict the share to a field subset (projection). */
  fields?: string[];
  expires_at?: number;
  resharable?: boolean;
  note?: string;
}

export interface ShareGrant {
  tid: string;
  doc_tid?: string;
  target?: string;
  token?: string;
  [k: string]: unknown;
}

export interface SharedDoc<T = Record<string, unknown>> {
  doc_tid: string;
  resource_ma: string;
  resource_name: string;
  author: string;
  data: T;
  created_at: number;
  updated_at: number;
}

export class SharesClient {
  constructor(private readonly http: HttpCore) {}

  /** Create a share grant. Returns the grant (with a `token` for links). */
  create(input: CreateShareInput): Promise<ShareGrant> {
    return this.http.post<ShareGrant>("/app/share/create", input);
  }

  /** List shares, optionally scoped to one doc. */
  list(docTid?: string): Promise<ShareGrant[]> {
    return this.http.post<ShareGrant[]>("/app/share/list", docTid ? { doc_tid: docTid } : {});
  }

  /** Revoke a share grant; its link stops working at once. */
  revoke(tid: string): Promise<void> {
    return this.http.post("/app/share/revoke", { tid }).then(() => undefined);
  }

  /**
   * Open an anonymous share link (no sign-in needed). Resolves the doc's
   * searchable (level-0) fields — narrowed to the share's `fields` when it
   * has them. Encrypted fields are never returned through a link.
   */
  claim<T extends Record<string, unknown> = Record<string, unknown>>(
    token: string,
    appTid?: string,
  ): Promise<SharedDoc<T>> {
    return this.http.post<SharedDoc<T>>("/app/share/claim", {
      token,
      ...(appTid !== undefined ? { app_tid: appTid } : {}),
    });
  }
}
