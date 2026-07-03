// SharesClient — `/app/share/*`. Per-doc grants + anonymous link claim.

import type { HttpCore } from "./http.js";
import type { Doc } from "./types.js";

export interface CreateShareInput {
  doc_tid: string;
  /**
   * REQUIRED token recipient: a bare `user_tid`, `G_<group>`, `[r_<role>]`,
   * `G_author`, or `anonymous` (the response then carries a random `token`
   * to hand out as a share link).
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
  doc_tid: string;
  token?: string;
  [k: string]: unknown;
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

  revoke(tid: string): Promise<void> {
    return this.http.post("/app/share/revoke", { tid }).then(() => undefined);
  }

  /** Anonymous link claim — exchange a share token for the doc. */
  claim<T extends Record<string, unknown> = Record<string, unknown>>(
    token: string,
  ): Promise<Doc<T>> {
    return this.http.post<Doc<T>>("/app/share/claim", { token });
  }
}
