// SourcesClient — `/app/source/*`. Signed inbound data channels (Manager-gated).
//
// A "source" is a signed inbound channel that lets an external system push
// data into a tfl5 resource. tfl5 auto-mints a service principal for each
// source; the caller never supplies a user id.
//
// Lifecycle:
//   1. `register(...)` → receive `{tid, secret, ingest_url, …}`. The
//      **secret is shown exactly once** — store it securely before discarding
//      the response.
//   2. External system pushes `POST /ingest/<source_tid>` with headers
//      `X-Tfl5-Timestamp` (unix secs) and `X-Tfl5-Signature` (HMAC-SHA256
//      hex of `"<ts>.<raw_body>"`). See docs/api-reference.md
//      §Signed sources for the push-side protocol.
//   3. `rotate(tid)` issues a new secret (shown once) if the old one leaks.
//   4. `revoke(tid)` soft-deletes + strips the auto-created principal grant.
//
// All four methods are Manager-gated; `app_tid` is auto-injected by HttpCore.

import type { HttpCore } from "./http.js";

export interface RegisterSourceInput {
  /** Human-readable channel name. */
  name: string;
  /** Machine alias of the resource this source writes into. */
  target_resource_ma: string;
  /**
   * A JSON POINTER into each pushed payload (e.g. `"/external_ref"`), not
   * an idempotency key for this `register` call. Whatever string the
   * pointer resolves to on an inbound `/ingest` body becomes that row's
   * dedup key, so the external system can retry a push without creating a
   * second doc. Omit for no per-row dedup; a pointer that resolves to
   * nothing (or to a non-string) simply yields no key for that push.
   *
   * `register` itself is NOT idempotent: every call mints a NEW source
   * tid, a NEW service principal with app-Editor, and a NEW secret,
   * whatever you pass here. Retrying a `register` you are unsure about
   * therefore leaves an extra live channel behind — check {@link
   * SourcesClient.list} first, and {@link SourcesClient.revoke} anything
   * you created twice.
   */
  idempotency_pointer?: string;
  /**
   * Replay-protection window in seconds (default: 300). Requests whose
   * `X-Tfl5-Timestamp` is older than this are rejected.
   */
  replay_window_secs?: number;
}

export interface SourceRecord {
  tid: string;
  name: string;
  target_resource_ma: string;
  replay_window_secs: number;
  /**
   * The HMAC-SHA256 signing secret (hex). **Shown once on `register` and
   * `rotate`; absent on `list`.** Store it immediately.
   */
  secret?: string;
  /** The ingest URL to hand to the external system. */
  ingest_url?: string;
  /** The auto-minted service-principal user tid. Never supplied by the caller. */
  principal_user_tid?: string;
  [k: string]: unknown;
}

export class SourcesClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Register a new signed source channel. tfl5 auto-mints a service
   * principal — the caller never supplies a user id.
   *
   * The returned `secret` (hex) is **shown exactly once**. Store it
   * securely; use `rotate` to issue a replacement if it leaks.
   *
   * The external system pushes to `ingest_url` signing
   * `"<unix_ts_secs>.<raw_body>"` with HMAC-SHA256(secret) in headers
   * `X-Tfl5-Timestamp` + `X-Tfl5-Signature` (hex).
   * Full push-side protocol: docs/api-reference.md §Signed sources.
   */
  register(input: RegisterSourceInput): Promise<SourceRecord> {
    return this.http.post<SourceRecord>("/app/source/register", input);
  }

  /** List all sources for the scoped app. `secret` is NOT included. */
  list(): Promise<SourceRecord[]> {
    return this.http.post<SourceRecord[]>("/app/source/list", {});
  }

  /**
   * Rotate the signing secret. Returns a new `secret` (hex, shown once).
   * The old secret dies with the call — the ingest path unseals the stored
   * secret per request, so the very next push signed with the old one
   * fails its HMAC check. Swap the external system over first.
   *
   * ⚠ The response carries ONLY `tid` and `secret`. The other {@link
   * SourceRecord} fields (`name`, `target_resource_ma`,
   * `replay_window_secs`, `ingest_url`, `principal_user_tid`) are NOT
   * echoed here even though the shared record type declares them —
   * re-read {@link list} if you need them. An unknown, revoked, or
   * other-app `tid` raises `not_found` rather than rotating anything.
   */
  rotate(tid: string): Promise<SourceRecord> {
    return this.http.post<SourceRecord>("/app/source/rotate", { tid });
  }

  /**
   * Revoke a source: soft-deletes the channel (`revoked_at`) and strips
   * the auto-created service principal's app-Editor grant.
   *
   * A later push to that `ingest_url` is then answered as MISSING, not as
   * forbidden: the ingest handler loads the source with `revoked_at IS
   * NULL`, so it answers the platform's not-found shape — HTTP **200**
   * with `{result:false, code:"not_found"}` (this SDK turns that into a
   * `NotFoundError`). Do not have the external system branch on a 403, and
   * do not read the 200 as success. The stripped grant is the second line
   * of defence behind that filter, not the thing the pusher observes.
   *
   * Revoking a `tid` that is already revoked (or belongs to another app)
   * raises the same `not_found` — the call is not idempotent-with-a-flag,
   * it simply fails the second time.
   */
  revoke(tid: string): Promise<void> {
    return this.http.post("/app/source/revoke", { tid }).then(() => undefined);
  }
}
