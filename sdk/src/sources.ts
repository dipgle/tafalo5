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
   * Optional idempotency key. Sending the same `idempotency_pointer` a
   * second time returns the original source record without creating a
   * duplicate (secret NOT re-emitted).
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
   * The old secret is immediately invalidated.
   */
  rotate(tid: string): Promise<SourceRecord> {
    return this.http.post<SourceRecord>("/app/source/rotate", { tid });
  }

  /**
   * Revoke a source: soft-deletes the channel and strips the auto-created
   * service-principal grant. Subsequent push attempts receive `403`.
   */
  revoke(tid: string): Promise<void> {
    return this.http.post("/app/source/revoke", { tid }).then(() => undefined);
  }
}
