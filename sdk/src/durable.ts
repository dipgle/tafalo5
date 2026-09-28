// DurableClient — send messages to durable operator instances, and subscribe
// to their reactive projections.
//
// Send contract:
//   POST /durable/:op_id/:instance_key/msg
//   Request JSON: { app_tid: string, msg?: any, idem_key?: string }
//   Success (HTTP 200, result:true):
//     { result: true, data: any, instance_tid: string, timestamp: number,
//       deduplicated?: true }
//   Not delivered (HTTP 200, result:false):
//     { result: false, code: "instance_busy" | "wrong_cell" | …,
//       msg: string, timestamp: number }
//   Auth: require_app_perm(Editor)
//
// Subscribe contract:
//   Single-resource (legacy):
//     GET /ws/durable/subscribe?app_tid=&resource=&key=k1&key=k2
//   Multi-resource (new):
//     GET /ws/durable/subscribe?app_tid=&rk=board%1Fk1&rk=scores%1Fk1
//     (%1F = ASCII Unit Separator; separator is unambiguous as it cannot appear
//      in valid resource/key strings — tfl5 only accepts printable UTF-8).
//   Frames: welcome | snapshot | delta | heartbeat | error — see
//   DurableSubscription below. Auth: cookie session, require_app_perm(Reader).
//
// op_id and instance_key are validated server-side to [A-Za-z0-9_-]{1..=64}.

import type { HttpCore } from "./http.js";
import { makeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for {@link DurableClient.send}. */
export interface DurableSendInput {
  /** Target app tid (injected automatically when `tfl5.useApp(...)` is set). */
  appTid: string;
  /**
   * Durable operator id — must match [A-Za-z0-9_-]{1..=64}.
   * Identifies the WASM operator that owns this instance.
   */
  opId: string;
  /**
   * Instance key — must match [A-Za-z0-9_-]{1..=64}.
   * Together with `opId` and the app, uniquely names a single durable
   * instance (its oplog, lease, and state).
   */
  instanceKey: string;
  /** Arbitrary JSON message forwarded verbatim to the WASM operator. */
  msg?: unknown;
  /**
   * Client-chosen deduplication token. A retry using the same `idemKey`
   * (same app + instance) does not re-deliver — the server returns the
   * original message's result with `deduplicated: true`.
   */
  idemKey?: string;
}

/**
 * Result of {@link DurableClient.send}.
 *
 * When the message was accepted (`result: true`), `data` carries the WASM
 * operator's return value and `instanceTid` identifies the persistent
 * instance row.
 *
 * When the message was not delivered, `result` is `false` and `code` says
 * why. These are **not thrown** — the server answers them HTTP 200:
 * - `instance_busy` (`busy: true`) — another owner holds the instance; retry
 *   with back-off.
 * - `wrong_cell` (`wrongCell: true`) — the instance lives on another cell and
 *   this deployment could not forward the message; retry at
 *   {@link targetCell}. (Multi-cell deployments forward server-side.)
 * - `wrong_cell_needs_idem` — forwarding needs an `idemKey`; resend with one.
 * - `cell_forward_failed` — the server-side forward failed; retry with the
 *   same `idemKey` (exactly-once is preserved).
 * - `instance_quota`, `tick_deadline` — capacity or time limit; retry later
 *   (`data` carries the counts / deadline).
 * - `durable_disabled` — the feature is off on this server.
 * Other refusals (access denied, not found, validation) are thrown.
 */
export interface DurableSendResult {
  /** `true` = message accepted and executed; `false` = not delivered (retry). */
  result: boolean;
  /** WASM operator return value. Present when `result: true`. */
  data: unknown;
  /** Persistent instance identifier. Present when `result: true`. */
  instanceTid?: string;
  /** Epoch-ms timestamp from the server. */
  timestamp: number;
  /**
   * `true` when this was a duplicate `idemKey` retry. The server did not
   * re-deliver; `data` is the original message's journaled result.
   */
  deduplicated?: boolean;
  /**
   * `true` when delivery failed because the instance's lease is held by
   * another owner. Retry with exponential back-off.
   * Maps `code: "instance_busy"` from the server.
   */
  busy?: boolean;
  /**
   * `true` when the instance is placed on a different cell than the one that
   * received this request. The client should retry against the owning cell —
   * see {@link targetCell} for where. Maps `code: "wrong_cell"` from the server.
   */
  wrongCell?: boolean;
  /**
   * The owning cell to retry against, present on a `wrongCell` response. Use
   * `baseUrl` to re-issue the request at the correct cell (empty when the
   * server could not resolve the cell's `base_url`). Maps the server's
   * `cell_id` / `base_url` fields.
   */
  targetCell?: { cellId: string; baseUrl: string };
  /** `true` when retrying later can succeed (see `DURABLE_RETRYABLE_CODES`). */
  retryable?: boolean;
  /** Server code when `result` is `false` (see above). */
  code?: string;
  /** Human-readable server message (placement/busy cases). */
  msg?: string;
}

export interface DurableStats {
  fuelUsedTotal: number;
  busyMsTotal: number;
  msgsTotal: number;
  /** Last applied sequence number; -1 when the instance was never activated. */
  seq: number;
}

export interface DurableMailGrant {
  senderAppTid: string;
  /** `null` = the grant covers every operator of the app. */
  opId: string | null;
  createdBy: string;
  createdAt: number;
}

/** `send()` outcomes that resolve with `result: false` instead of throwing. */
const DURABLE_SOFT_CODES = new Set([
  "instance_busy",
  "wrong_cell",
  "wrong_cell_needs_idem",
  "cell_forward_failed",
  "instance_quota",
  "tick_deadline",
  "durable_disabled",
]);
/** Codes that carry the owning cell (`targetCell`). */
const CELL_CODES = new Set(["wrong_cell", "wrong_cell_needs_idem", "cell_forward_failed"]);
/** Codes worth retrying (with back-off, and the same `idemKey`). */
export const DURABLE_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "instance_busy",
  "wrong_cell",
  "cell_forward_failed",
  "instance_quota",
  "tick_deadline",
]);

function mailGrantBody(input: { senderAppTid: string; opId?: string; appTid?: string }): Record<string, unknown> {
  return {
    sender_app_tid: input.senderAppTid,
    ...(input.opId !== undefined ? { op_id: input.opId } : {}),
    ...(input.appTid !== undefined ? { app_tid: input.appTid } : {}),
  };
}

// ---------------------------------------------------------------------------
// DurableClient
// ---------------------------------------------------------------------------

/**
 * DurableClient — send messages to durable operator instances.
 *
 * A durable instance is a long-lived, replayed WASM actor identified by
 * `(app_tid, op_id, instance_key)`. The server activates it on first
 * delivery, persists its oplog, and guarantees exactly-once execution when
 * an `idemKey` is supplied.
 *
 * Endpoints: `POST /durable/:op_id/:instance_key/msg` (send),
 * `POST /durable/:op_id/:instance_key/stats`, `GET /ws/durable/subscribe`
 * (live projections, one key, many keys, or many resources per socket),
 * and `/app/durable/mail-grant*` (which other apps may message yours).
 *
 * Access level: **Editor** on the target app for `send`; **Reader** for
 * `stats` and `subscribe`; **Manager** for mail grants.
 */
export class DurableClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Send a message to a durable operator instance.
   *
   * Posts to `POST /durable/${opId}/${instanceKey}/msg` with
   * `{ app_tid, msg, idem_key }`. The server creates the instance on first
   * delivery, or reuses the warm instance when one is already running.
   *
   * Refusals (not signed in, access denied, unknown instance, bad request,
   * 5xx) are thrown as {@link Tfl5Error} subclasses, like every other SDK
   * method. Delivery outcomes — busy, wrong cell, quota, deadline, disabled —
   * resolve `{ result: false, code, retryable }` instead (see
   * {@link DurableSendResult}).
   *
   * @example
   * const res = await tfl5.durable.send({
   *   appTid: "app-xxx",
   *   opId: "counter",
   *   instanceKey: "user-42",
   *   msg: { action: "increment", by: 1 },
   *   idemKey: "req-abc-001",
   * });
   * if (!res.result && res.retryable) { // retry after back-off, same idemKey }
   * if (res.result) console.log(res.data);
   */
  async send(input: DurableSendInput): Promise<DurableSendResult> {
    const body: Record<string, unknown> = {
      app_tid: input.appTid,
      msg: input.msg,
    };
    if (input.idemKey !== undefined) body["idem_key"] = input.idemKey;

    // Metadata (`instance_tid`, `deduplicated`, placement fields) sits beside
    // `data`, so read the whole body. `postFull` throws for non-2xx only; the
    // rest is classified here.
    interface RawEnvelope {
      result: boolean;
      data?: unknown;
      instance_tid?: string;
      timestamp: number;
      deduplicated?: boolean;
      code?: string;
      msg?: string;
      cell_id?: string;
      base_url?: string;
      retryable?: boolean;
      isSignout?: boolean;
    }

    const raw = await this.http.postFull<RawEnvelope>(
      `/durable/${input.opId}/${input.instanceKey}/msg`,
      body,
    );

    // A signed-out caller can be answered `{isSignout:true, result:true}`.
    if (raw.isSignout === true) throw makeError(401, { ...raw, code: raw.code ?? "unauthorized" });

    if (raw.result === true) {
      return {
        result: true,
        data: raw.data,
        instanceTid: raw.instance_tid,
        timestamp: raw.timestamp,
        deduplicated: raw.deduplicated,
      };
    }

    // result:false. Delivery outcomes resolve; any other refusal (access
    // denied, not found, validation) is an error like everywhere else.
    if (raw.code !== undefined && !DURABLE_SOFT_CODES.has(raw.code)) throw makeError(200, raw);

    const placed = raw.code !== undefined && CELL_CODES.has(raw.code);
    return {
      result: false,
      data: raw.data,
      instanceTid: raw.instance_tid,
      timestamp: raw.timestamp,
      busy: raw.code === "instance_busy",
      wrongCell: raw.code === "wrong_cell",
      targetCell: placed ? { cellId: raw.cell_id ?? "", baseUrl: raw.base_url ?? "" } : undefined,
      retryable: raw.code !== undefined && DURABLE_RETRYABLE_CODES.has(raw.code),
      code: raw.code,
      msg: raw.msg,
    };
  }

  /**
   * Metering counters of one instance (Reader). A never-activated instance
   * reads as all zeros with `seq: -1`. Throws with code `durable_disabled`
   * when the durable subsystem is off on this deployment.
   */
  async stats(input: { appTid?: string; opId: string; instanceKey: string }): Promise<DurableStats> {
    const r = await this.http.post<{
      fuel_used_total: number;
      busy_ms_total: number;
      msgs_total: number;
      seq: number;
    }>(`/durable/${input.opId}/${input.instanceKey}/stats`, input.appTid ? { app_tid: input.appTid } : {});
    return {
      fuelUsedTotal: r.fuel_used_total,
      busyMsTotal: r.busy_ms_total,
      msgsTotal: r.msgs_total,
      seq: r.seq,
    };
  }

  /**
   * Allow another app (`senderAppTid`) to message this app's durable
   * operators — all of them, or only `opId` (Manager on this app).
   * Idempotent: `created` is false when the grant already existed.
   */
  async grantMail(input: { senderAppTid: string; opId?: string; appTid?: string }): Promise<{ created: boolean }> {
    const r = await this.http.post<{ created: boolean }>("/app/durable/mail-grant", mailGrantBody(input));
    return { created: r.created };
  }

  /** Remove a mail grant; undelivered messages from that sender are refused at once. */
  async revokeMail(input: { senderAppTid: string; opId?: string; appTid?: string }): Promise<{ revoked: number }> {
    const r = await this.http.post<{ revoked: number }>("/app/durable/mail-grant/revoke", mailGrantBody(input));
    return { revoked: r.revoked };
  }

  /** Apps allowed to message this app's durable operators. */
  async listMailGrants(appTid?: string): Promise<DurableMailGrant[]> {
    const r = await this.http.post<{
      grants: Array<{ sender_app_tid: string; op_id: string | null; created_by: string; created_at: number }>;
    }>("/app/durable/mail-grant/list", appTid ? { app_tid: appTid } : {});
    return r.grants.map((g) => ({
      senderAppTid: g.sender_app_tid,
      opId: g.op_id,
      createdBy: g.created_by,
      createdAt: g.created_at,
    }));
  }

  /**
   * Subscribe to durable instance projections — a live, read-only view of
   * the rows guests `project` under `(resource, key)`, streamed over
   * `GET /ws/durable/subscribe` (WebSocket). One socket carries either a
   * single `key` or up to {@link SUBSCRIBE_KEYS_MAX} `keys` of the SAME
   * resource (single-resource form), OR up to {@link SUBSCRIBE_KEYS_MAX}
   * `{resource, key}` pairs across MULTIPLE resources (multi-resource form via
   * `subs`). Frames are (resource,key)-attributed; the row set (and each
   * `onUpdate`) spans all pairs, with per-pair reads via
   * `sub.rows(resource, key)`.
   *
   * The subscription keeps a **latest-wins** local copy: a `snapshot` frame
   * replaces it, each `delta` upserts one row (stale/duplicate seq dropped),
   * and the server's seq-only `heartbeat` is compared against the local rows —
   * a newer seq on the wire than held locally means a delta was missed
   * (NOTIFY is at-most-once), and the subscription **resyncs** by reconnecting
   * (a fresh socket always begins with a full snapshot). Resync waits a 1s
   * grace first: the server commits a row before pushing its delta, so the
   * "missing" delta is often already in flight — catching up cancels the
   * reconnect.
   *
   * Rows are ACL- and PII-filtered SERVER-side under the caller's scope —
   * what you receive is exactly what `/app/doc/list` would show you.
   *
   * Auth is the cookie session (same as `/ws/chat`): in a browser on the
   * app's origin it just works. The browser `WebSocket` API cannot attach
   * an `Authorization` header, so bearer-mode Node callers must pass a
   * {@link DurableSubscribeOptions.webSocket} factory that injects their own
   * auth (e.g. the `ws` package with a `Cookie: _token=...` header).
   *
   * Pre-upgrade refusals (`durable_disabled` / `projections_disabled` flags,
   * missing Reader permission → 401, key quota → 402 `proj_keys_quota`)
   * happen BEFORE the 101 handshake — a browser surfaces them only as a
   * failed connection, so the client retries with back-off and reports
   * `onStatus("connecting")`; check the server if it never goes `"live"`.
   *
   * Access level: **Reader** on the app.
   *
   * @example
   * const sub = tfl5.durable.subscribe(
   *   { appTid: "app-xxx", resource: "board", key: "k1" },
   *   { onUpdate: (rows) => render(rows) },
   * );
   * // ... later
   * sub.close();
   *
   * @example
   * // Multi-key: one socket, three boards; re-render only what changed.
   * const sub = tfl5.durable.subscribe(
   *   { appTid: "app-xxx", resource: "board", keys: ["k1", "k2", "k3"] },
   *   { onUpdate: (_rows, key) => renderBoard(key, sub.rows(key)) },
   * );
   *
   * @example
   * // Multi-resource: one socket watches boards and scores simultaneously.
   * const sub = tfl5.durable.subscribe(
   *   {
   *     appTid: "app-xxx",
   *     subs: [{ resource: "board", key: "k1" }, { resource: "scores", key: "k1" }],
   *   },
   *   { onUpdate: (_rows, key, resource) => renderPanel(resource, key, sub.rows(resource, key)) },
   * );
   */
  subscribe(
    input: DurableSubscribeInput,
    opts: DurableSubscribeOptions = {},
  ): DurableSubscription {
    return new DurableSubscription(this.http, input, opts);
  }
}

// ---------------------------------------------------------------------------
// Reactive projection subscription
// ---------------------------------------------------------------------------

/**
 * Max distinct (resource, key) pairs one subscribe socket may carry — mirror
 * of the server's per-socket limit
 * (a socket over the cap is refused 400 pre-upgrade, which a browser only
 * surfaces as a failed connection — so the SDK throws the clear error
 * client-side).
 */
export const SUBSCRIBE_KEYS_MAX = 16;

/** One (resource, key) subscription target — used in `subs` form. */
export interface ResourceKeyPair {
  /** Projection resource name (server caps at 512 chars). */
  resource: string;
  /** Projection key within the resource (server caps at 512 chars). */
  key: string;
}

/**
 * Input for {@link DurableClient.subscribe}.
 *
 * Two forms — mutually exclusive:
 *
 * **Single-resource form** (original API, fully supported):
 *   Pass `resource` + exactly one of `key` (single key) or `keys`
 *   (1..={@link SUBSCRIBE_KEYS_MAX} keys, duplicates collapse first-wins).
 *   Uses the `?resource=&key=` wire encoding.
 *
 * **Multi-resource form** (new):
 *   Pass `subs: ResourceKeyPair[]` — an array of `{resource, key}` pairs
 *   (1..={@link SUBSCRIBE_KEYS_MAX} pairs, duplicates collapse first-wins).
 *   Uses the `?rk=resource%1Fkey` wire encoding (U+001F separator).
 *   Mutually exclusive with `resource`/`key`/`keys`.
 */
export interface DurableSubscribeInput {
  /** Target app tid (injected automatically when `tfl5.useApp(...)` is set). */
  appTid?: string;

  // ----- Single-resource form -----
  /** Projection resource name (server caps at 512 chars). */
  resource?: string;
  /** Projection key within the resource (server caps at 512 chars). */
  key?: string;
  /**
   * Multiple projection keys on one socket (max {@link SUBSCRIBE_KEYS_MAX};
   * duplicates collapse first-wins, mirroring the server). Mutually exclusive
   * with `key`.
   */
  keys?: string[];

  // ----- Multi-resource form -----
  /**
   * Array of `{resource, key}` pairs for a multi-resource socket. Each pair
   * costs one quota slot. Mutually exclusive with `resource`/`key`/`keys`.
   * Duplicates collapse first-wins, mirroring the server parse.
   */
  subs?: ResourceKeyPair[];
}

/** One projected row, latest-wins per `(resource, key, instance)`. */
export interface ProjectionRow {
  /** The resource this row was projected under. */
  resource: string;
  /** The projection key this row belongs to. */
  key: string;
  /** The durable instance that projected this row. */
  instanceTid: string;
  /** Monotonic per-instance commit seq — highest wins. */
  seq: number;
  /** The projected document, ACL/PII-filtered under the caller's scope. */
  doc: unknown;
}

/**
 * Subscription lifecycle:
 * `"connecting"` (socket opening / retrying) → `"live"` (snapshot applied) →
 * `"behind"` (heartbeat showed a missed delta; auto-resync follows) →
 * `"closed"` (after {@link DurableSubscription.close} — terminal).
 */
export type DurableSubscriptionStatus = "connecting" | "live" | "behind" | "closed";

/** A non-fatal server `error` frame (the stream continues). */
export interface DurableSubscriptionError {
  /** `"lagged"` (fresh snapshot follows), `"read_failed"`, `"read_only_stream"`. */
  code: string;
  /** Human-readable server message. */
  msg: string;
  /**
   * The resource the error applies to, when resource-scoped (multi-resource
   * servers tag `lagged` / `read_failed` with both `resource` and `key`).
   */
  resource?: string;
  /**
   * The projection key the error applies to, when key-scoped (`"lagged"` is —
   * only that key's snapshot follows; the other keys were not affected).
   */
  key?: string;
}

/** Minimal WebSocket surface — satisfied by the browser API and `ws`. */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

/** Options for {@link DurableClient.subscribe}. */
export interface DurableSubscribeOptions {
  /**
   * Called after every applied change (snapshot replace / delta upsert) with
   * the full latest-wins row set across ALL subscribed (resource,key) pairs,
   * sorted by `(resource, key, instanceTid)` for stable renders. The second
   * argument is the key the change applied to; the third is the resource (for
   * multi-resource sockets). Multi-resource consumers can re-render just that
   * pair's view: `sub.rows(resource, key)`. Old 2-arg callbacks `(rows, key)`
   * remain valid — the extra `resource` arg is ignored by JS.
   */
  onUpdate?: (rows: ProjectionRow[], key: string, resource: string) => void;
  /** Called on every lifecycle transition — see {@link DurableSubscriptionStatus}. */
  onStatus?: (status: DurableSubscriptionStatus) => void;
  /** Called for non-fatal server `error` frames; the stream continues. */
  onError?: (err: DurableSubscriptionError) => void;
  /**
   * WebSocket factory. Defaults to `globalThis.WebSocket`. Node callers (or
   * tests) pass their own, e.g. `(url) => new WsPackage(url, { headers })`.
   */
  webSocket?: (url: string) => WebSocketLike;
  /**
   * Reconnect automatically on unexpected close and resync when behind
   * (default `true`). `false` = the first unexpected close is terminal
   * (goes straight to `"closed"`).
   */
  autoReconnect?: boolean;
}

/**
 * A live projection subscription — returned by {@link DurableClient.subscribe}.
 *
 * Holds the latest-wins row set locally (read it with {@link rows}), applies
 * the server's frame protocol, and self-heals: unexpected close → back-off
 * reconnect (1s doubling, capped 30s, reset once the socket reaches
 * `"live"`); heartbeat showing a missed delta → `"behind"` + resync; a
 * failed join read (`read_failed` before every pair snapshotted) → resync
 * (reconnect; a fresh socket snapshots afresh). {@link close} is terminal.
 *
 * Supports both single-resource (`resource`+`key`/`keys`) and multi-resource
 * (`subs`) input forms. State is keyed by `(resource, key)` pairs throughout.
 */
export class DurableSubscription {
  /** Current lifecycle status. */
  status: DurableSubscriptionStatus = "connecting";

  /**
   * Latest-wins rows per (resource, key) compound key, then per instance.
   * Compound key = `resource + U+001F + key` (same separator as the wire
   * encoding, unambiguous since neither field may contain U+001F).
   */
  private readonly bySub = new Map<string, Map<string, ProjectionRow>>();
  /**
   * The deduped (first-wins) ordered list of (resource, key) subscription
   * targets on this socket.
   */
  private readonly subs: readonly ResourceKeyPair[];
  /**
   * (resource,key) compound keys whose post-(re)connect snapshot has not yet
   * arrived. Refilled on every connect; `"live"` fires only once ALL pairs
   * have snapshotted (a socket with 1 of 3 snapshots applied is not usable).
   */
  private pendingSnapshots = new Set<string>();
  private ws?: WebSocketLike;
  private closed = false;
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private behindTimer?: ReturnType<typeof setTimeout>;

  constructor(
    http: HttpCore,
    input: DurableSubscribeInput,
    private readonly opts: DurableSubscribeOptions,
  ) {
    this.subs = DurableSubscription.resolveSubs(input);
    for (const { resource, key } of this.subs) {
      this.bySub.set(DurableSubscription.rkKey(resource, key), new Map());
    }
    this.url = DurableSubscription.buildUrl(http, input, this.subs);
    this.connect();
  }

  private readonly url: string;

  /** Compound key for the bySub / pendingSnapshots maps. */
  private static rkKey(resource: string, key: string): string {
    return `${resource}\x1f${key}`;
  }

  /**
   * The latest-wins projected rows — filtered by `resource` and/or `key`
   * when given, across all subscribed pairs otherwise. Sorted by
   * `(resource, key, instanceTid)` for stable renders.
   *
   * Single-resource callers: pass only `key` (first arg) — resource is
   * optional and may be omitted. Multi-resource callers: pass `resource`
   * as the first arg and `key` as the second for precise filtering.
   *
   * Overloads to preserve backward-compatible single-resource call shape
   * `rows(key?)` while supporting `rows(resource, key)`:
   * - `rows()` → all rows across every subscribed pair
   * - `rows(key)` → rows for every pair whose key equals `key` (single-
   *   resource compat; on a multi-resource socket this may span resources)
   * - `rows(resource, key)` → rows for the specific (resource, key) pair
   */
  rows(resourceOrKey?: string, key?: string): ProjectionRow[] {
    const out: ProjectionRow[] = [];
    if (resourceOrKey === undefined) {
      // All pairs.
      for (const m of this.bySub.values()) out.push(...m.values());
    } else if (key !== undefined) {
      // Specific (resource, key) pair.
      const m = this.bySub.get(DurableSubscription.rkKey(resourceOrKey, key));
      if (m !== undefined) out.push(...m.values());
    } else {
      // `resourceOrKey` is treated as `key` for backward compat (single-
      // resource sockets where the first arg was always the key).
      for (const sub of this.subs) {
        if (sub.key === resourceOrKey) {
          const m = this.bySub.get(DurableSubscription.rkKey(sub.resource, sub.key));
          if (m !== undefined) out.push(...m.values());
        }
      }
    }
    return out.sort((a, b) =>
      a.resource < b.resource
        ? -1
        : a.resource > b.resource
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : a.instanceTid < b.instanceTid
                ? -1
                : a.instanceTid > b.instanceTid
                  ? 1
                  : 0,
    );
  }

  /**
   * One instance's latest row, if visible under the caller's scope.
   *
   * Call forms:
   * - `get(instanceTid)` — only valid on a single-(resource,key) socket.
   * - `get(instanceTid, key)` — backward-compat: `key` selects the subscribed
   *   key when all subs share one resource (single-resource sockets, including
   *   multi-key ones). Equivalent to the old 2-arg form.
   * - `get(instanceTid, resource, key)` — full form for multi-resource sockets.
   */
  get(instanceTid: string, resourceOrKey?: string, key?: string): ProjectionRow | undefined {
    let rk: string;
    if (key !== undefined && resourceOrKey !== undefined) {
      // Full (resource, key) form — 3 args.
      rk = DurableSubscription.rkKey(resourceOrKey, key);
    } else if (resourceOrKey !== undefined) {
      // 2-arg form: resourceOrKey is the KEY (backward compat with single-
      // resource multi-key sockets). Valid when all subs share one resource.
      const resources = new Set(this.subs.map((s) => s.resource));
      if (resources.size !== 1) {
        throw new Error(
          "durable.subscribe: get(instanceTid, key) is ambiguous on a multi-resource subscription — pass get(instanceTid, resource, key)",
        );
      }
      // All subs share one resource — use it as the implicit resource.
      const resource = this.subs[0]?.resource ?? "";
      rk = DurableSubscription.rkKey(resource, resourceOrKey);
    } else {
      // No resource/key — only valid on a single-pair socket.
      const sole = this.subs[0];
      if (this.subs.length !== 1 || sole === undefined) {
        throw new Error(
          "durable.subscribe: get(instanceTid) is ambiguous on a multi-key subscription — pass get(instanceTid, key) or get(instanceTid, resource, key)",
        );
      }
      rk = DurableSubscription.rkKey(sole.resource, sole.key);
    }
    return this.bySub.get(rk)?.get(instanceTid);
  }

  /** Close the socket and stop reconnecting. Terminal. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.behindTimer !== undefined) clearTimeout(this.behindTimer);
    try {
      this.ws?.close(1000, "client close");
    } catch {
      // A socket already CLOSING/CLOSED may throw in some runtimes — the
      // subscription is terminal either way.
    }
    this.setStatus("closed");
  }

  /**
   * Normalize the input into an ordered, deduped list of (resource, key)
   * subscription pairs. Validates mutual exclusivity of the two input forms,
   * 1..={@link SUBSCRIBE_KEYS_MAX} pairs, and duplicate collapse (first-wins,
   * byte-identical to the server's parse). Config errors throw synchronously —
   * the server refuses them pre-upgrade.
   */
  private static resolveSubs(input: DurableSubscribeInput): ResourceKeyPair[] {
    const hasSingleRes = input.resource !== undefined;
    const hasMultiRes = input.subs !== undefined;
    if (hasSingleRes && hasMultiRes) {
      throw new Error(
        "durable.subscribe: pass either resource+key/keys (single-resource) or subs (multi-resource), not both",
      );
    }
    if (input.key !== undefined && input.keys !== undefined) {
      throw new Error("durable.subscribe: pass either key or keys, not both");
    }

    let pairs: ResourceKeyPair[];
    if (hasMultiRes) {
      // Multi-resource form: subs=[{resource, key}, ...]
      if (input.subs !== undefined && (input.key !== undefined || input.keys !== undefined)) {
        throw new Error(
          "durable.subscribe: subs is mutually exclusive with key and keys",
        );
      }
      const raw = input.subs ?? [];
      pairs = [];
      for (const p of raw) {
        if (!pairs.some((x) => x.resource === p.resource && x.key === p.key)) {
          pairs.push({ resource: p.resource, key: p.key });
        }
      }
    } else if (hasSingleRes) {
      // Single-resource form: resource + key | keys
      const resource = input.resource!;
      const rawKeys = input.keys ?? (input.key !== undefined ? [input.key] : []);
      const keys: string[] = [];
      for (const k of rawKeys) if (!keys.includes(k)) keys.push(k);
      if (keys.length === 0) {
        throw new Error("durable.subscribe: at least one key is required");
      }
      pairs = keys.map((k) => ({ resource, key: k }));
    } else {
      throw new Error("durable.subscribe: at least one key is required");
    }

    if (pairs.length === 0) {
      throw new Error("durable.subscribe: at least one key is required");
    }
    if (pairs.length > SUBSCRIBE_KEYS_MAX) {
      throw new Error(
        `durable.subscribe: at most ${SUBSCRIBE_KEYS_MAX} distinct (resource,key) pairs per subscription (got ${pairs.length})`,
      );
    }
    return pairs;
  }

  private static buildUrl(
    http: HttpCore,
    input: DurableSubscribeInput,
    subs: readonly ResourceKeyPair[],
  ): string {
    const appTid = input.appTid ?? http.appId;
    if (!appTid) {
      throw new Error(
        "durable.subscribe: appTid is required (pass it or set tfl5.useApp(...))",
      );
    }
    if (!http.host) {
      throw new Error("durable.subscribe: host is required outside a browser");
    }
    const ws = http.host.replace(/^http/, "ws"); // http→ws, https→wss

    if (input.subs !== undefined) {
      // Multi-resource form: repeated `rk=<resource>%1F<key>` params.
      // The Unit Separator (U+001F) is percent-encoded as %1F by
      // URLSearchParams.append — server decodes it and splits on the literal
      // character, which cannot appear in printable resource/key strings.
      const q = new URLSearchParams({ app_tid: appTid });
      for (const { resource, key } of subs) {
        q.append("rk", `${resource}\x1f${key}`);
      }
      return `${ws}/ws/durable/subscribe?${q.toString()}`;
    } else {
      // Single-resource form (legacy): resource= + repeated key= params.
      // keys may contain commas, so the server rejected comma-separation;
      // it hand-parses RawQuery with form-urlencoded semantics, which
      // URLSearchParams emits (space as `+` decodes the same).
      const firstSub = subs[0];
      const q = new URLSearchParams({
        app_tid: appTid,
        resource: input.resource ?? firstSub?.resource ?? "",
      });
      for (const { key } of subs) q.append("key", key);
      return `${ws}/ws/durable/subscribe?${q.toString()}`;
    }
  }

  private setStatus(next: DurableSubscriptionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.opts.onStatus?.(next);
  }

  private connect(): void {
    if (this.closed) return;
    // A fresh socket snapshots every (resource,key) pair from scratch; "live"
    // is re-earned only once ALL pairs have snapshotted.
    this.pendingSnapshots = new Set(
      this.subs.map((s) => DurableSubscription.rkKey(s.resource, s.key)),
    );
    const factory =
      this.opts.webSocket ??
      ((url: string) => {
        const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
          .WebSocket;
        if (!Ctor) {
          throw new Error(
            "durable.subscribe: no global WebSocket — pass opts.webSocket (e.g. the 'ws' package)",
          );
        }
        return new Ctor(url);
      });
    this.setStatus("connecting");
    let ws: WebSocketLike;
    try {
      ws = factory(this.url);
    } catch (e) {
      // First connect runs in the constructor — surface config errors (no
      // global WebSocket, broken factory) synchronously to the caller. A
      // RECONNECT runs inside a bare timer callback, where a throw would be
      // an uncaught exception AND leave no timer scheduled (dead
      // subscription) — back off and retry instead.
      if (this.ws === undefined) throw e;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onFrame(ev.data);
    };
    // Browsers fire error+close together, `ws` can fire error alone on a
    // failed handshake, and a replaced socket can close late — every handler
    // is identity-guarded so only the CURRENT socket drives the lifecycle.
    ws.onclose = () => this.onSocketDown(ws);
    ws.onerror = () => this.onSocketDown(ws);
    ws.onopen = null; // welcome frame, not open, marks the stream usable
  }

  private onSocketDown(from: WebSocketLike): void {
    if (this.closed) return;
    if (this.ws !== from) return; // stale socket's late event
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== undefined) return; // already scheduled
    if (this.opts.autoReconnect === false) {
      this.close();
      return;
    }
    this.setStatus("connecting");
    const delay = Math.min(1000 * 2 ** this.attempts, 30_000);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** Resync after "behind": drop the socket; reconnect snapshots afresh. */
  private resync(): void {
    if (this.closed) return;
    try {
      this.ws?.close(1000, "resync");
    } catch {
      // Ignore — onclose still fires and schedules the reconnect.
    }
    // onSocketDown (via onclose) schedules the reconnect with back-off.
  }

  private onFrame(data: unknown): void {
    if (this.closed) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      this.opts.onError?.({ code: "bad_frame", msg: "unparseable frame" });
      return;
    }
    switch (frame["type"]) {
      case "welcome": {
        // Stream is live from the server's side; the snapshots follow. The
        // back-off reset waits for "live" — a server that accepts the socket
        // but fails every snapshot read must keep backing off, not loop at
        // the floor delay.
        //
        // Multi-resource server: welcome carries `subs` list. Single-resource
        // server (legacy): carries `keys` list. Validate what we can from the
        // echo; a mismatch signals version skew.
        const subsEcho = frame["subs"];
        if (Array.isArray(subsEcho)) {
          // New multi-resource server echo.
          const echoPairs = subsEcho.map(
            (s) =>
              `${(s as Record<string, unknown>)["resource"]}:${(s as Record<string, unknown>)["key"]}`,
          );
          const ourPairs = this.subs.map((s) => `${s.resource}:${s.key}`);
          if (
            echoPairs.length !== ourPairs.length ||
            echoPairs.some((p, i) => p !== ourPairs[i])
          ) {
            this.opts.onError?.({
              code: "subs_mismatch",
              msg: `server subscribed [${echoPairs.join(", ")}] but client asked for [${ourPairs.join(", ")}]`,
            });
          }
        } else {
          // Legacy single-resource server: check keys echo.
          const keysEcho = frame["keys"];
          const ourKeys = this.subs.map((s) => s.key);
          if (
            Array.isArray(keysEcho) &&
            (keysEcho.length !== ourKeys.length || keysEcho.some((k, i) => k !== ourKeys[i]))
          ) {
            this.opts.onError?.({
              code: "keys_mismatch",
              msg: `server subscribed [${(keysEcho as string[]).join(", ")}] but client asked for [${ourKeys.join(", ")}]`,
            });
          }
        }
        break;
      }
      case "snapshot": {
        // Replaces ONE (resource,key) pair's rows (on join per pair, and after
        // that pair lags).
        const pair = this.framePair(frame);
        if (pair === undefined) break;
        const rk = DurableSubscription.rkKey(pair.resource, pair.key);
        const m = this.bySub.get(rk);
        if (m === undefined) break; // framePair guarantees membership
        m.clear();
        for (const r of this.rawRows(frame, pair.resource, pair.key)) m.set(r.instanceTid, r);
        this.pendingSnapshots.delete(rk);
        if (this.pendingSnapshots.size === 0) {
          // The full post-connect view is assembled — the socket has earned
          // its back-off reset (see the welcome case for why not earlier).
          this.attempts = 0;
          this.setStatus("live");
        }
        this.opts.onUpdate?.(this.rows(), pair.key, pair.resource);
        break;
      }
      case "delta": {
        const pair = this.framePair(frame);
        if (pair === undefined) break;
        const r = this.toRow(frame, pair.resource, pair.key);
        if (r === undefined) break;
        const rk = DurableSubscription.rkKey(pair.resource, pair.key);
        const m = this.bySub.get(rk);
        if (m === undefined) break;
        const held = m.get(r.instanceTid);
        // Latest-wins: drop stale seq; equal seq re-applies (the server
        // re-reads latest per delta, so same-seq doc is fresh, not stale).
        if (held !== undefined && r.seq < held.seq) break;
        m.set(r.instanceTid, r);
        this.opts.onUpdate?.(this.rows(), pair.key, pair.resource);
        break;
      }
      case "heartbeat": {
        // Liveness backstop: a wire seq ahead of ours (or an instance we
        // never saw) means a delta was dropped — resync via fresh snapshot.
        // Rows are now (resource,key,instance)-attributed.
        const wire: Array<{ resource: string; key: string; tid: string; seq: number }> = [];
        for (const raw of (frame["rows"] as unknown[] | undefined) ?? []) {
          const row = raw as {
            instance_tid?: unknown;
            seq?: unknown;
            key?: unknown;
            resource?: unknown;
          };
          if (typeof row.instance_tid !== "string" || typeof row.seq !== "number") {
            continue;
          }
          // Resolve resource: new server sends it; old single-resource server
          // omits it. Fall back to the implicit resource when all subs share
          // one resource (covers multi-key single-resource sockets), or when
          // there is exactly one sub (single-key sockets).
          const rowKey = typeof row.key === "string" ? row.key : undefined;
          const rowResource = typeof row.resource === "string" ? row.resource : undefined;
          let resource = rowResource;
          let key = rowKey;
          if (resource === undefined && rowKey !== undefined) {
            // Try to resolve resource by matching key against subs that share
            // the same key — if all matching subs agree on one resource, use it.
            const matches = this.subs.filter((s) => s.key === rowKey);
            const resSet = new Set(matches.map((s) => s.resource));
            if (resSet.size === 1) resource = matches[0]?.resource;
          }
          if (resource === undefined && key === undefined) {
            const soleSub = this.subs.length === 1 ? this.subs[0] : undefined;
            resource = soleSub?.resource;
            key = soleSub?.key;
          }
          if (resource === undefined || key === undefined) continue;
          if (!this.bySub.has(DurableSubscription.rkKey(resource, key))) continue;
          wire.push({ resource, key, tid: row.instance_tid, seq: row.seq });
        }
        if (!this.isBehind(wire) || this.behindTimer !== undefined) break;
        // Grace before resyncing: the server commits the projection row
        // BEFORE pushing the delta to the bus, so a heartbeat read can be
        // one commit ahead of a delta that is already in flight on this
        // socket. Re-check after a beat; resync only if still behind.
        this.behindTimer = setTimeout(() => {
          this.behindTimer = undefined;
          if (this.closed) return;
          if (this.isBehind(wire)) {
            this.setStatus("behind");
            this.resync();
          }
        }, 1000);
        break;
      }
      case "error": {
        const code = typeof frame["code"] === "string" ? frame["code"] : "unknown";
        const msg = typeof frame["msg"] === "string" ? frame["msg"] : "";
        // "lagged" / "read_failed" carry the affected (resource, key) and are
        // followed by a fresh snapshot for THAT pair from the server — no
        // client action needed for "lagged" beyond surfacing it.
        const err: DurableSubscriptionError = { code, msg };
        if (typeof frame["key"] === "string") err.key = frame["key"];
        if (typeof frame["resource"] === "string") err.resource = frame["resource"];
        this.opts.onError?.(err);
        // A read_failed for a (resource,key) still awaiting its post-connect
        // snapshot means that snapshot is NOT coming (the server keeps the
        // socket open after a failed join read). Left alone, the pair would
        // sit in pendingSnapshots forever — never "live", and exempt from
        // heartbeat behind-detection. The only recovery is a fresh socket (it
        // re-snapshots every pair), so resync.
        //
        // A keyed failure resyncs only when THAT pair's snapshot is pending
        // (a live pair's delta re-read hiccup must not tear down a socket
        // still assembling other pairs — the heartbeat's seq check owns post-
        // live recovery). A key-only frame (older server, no resource field)
        // looks up by key alone; a fully anonymous frame falls back to
        // resyncing when ANY pair is pending.
        if (code === "read_failed") {
          let joinFailed: boolean;
          if (err.resource !== undefined && err.key !== undefined) {
            // Fully attributed: check only this (resource,key) pair.
            joinFailed = this.pendingSnapshots.has(
              DurableSubscription.rkKey(err.resource, err.key),
            );
          } else if (err.key !== undefined) {
            // Key-only (old server, no resource in error frame): check all
            // pending pairs with this key.
            joinFailed = [...this.pendingSnapshots].some((rk) => rk.endsWith(`\x1f${err.key}`));
          } else {
            // Anonymous: resync when any pair is pending.
            joinFailed = this.pendingSnapshots.size > 0;
          }
          if (joinFailed) this.resync();
        }
        break;
      }
      default:
        // Unknown frame types are forward-compatible no-ops.
        break;
    }
  }

  /**
   * Resolve which (resource, key) pair a frame belongs to. New servers
   * tag every snapshot/delta with both `resource` and `key`. A server
   * with only `key` (single-resource) is resolved by key alone (unambiguous
   * when the key uniquely identifies one sub). An unresolvable frame is
   * surfaced via onError and skipped — never silently misfiled.
   */
  private framePair(frame: Record<string, unknown>): ResourceKeyPair | undefined {
    const key = typeof frame["key"] === "string" ? frame["key"] : undefined;
    const resource = typeof frame["resource"] === "string" ? frame["resource"] : undefined;

    if (resource !== undefined && key !== undefined) {
      // Fully attributed frame.
      const rk = DurableSubscription.rkKey(resource, key);
      if (this.bySub.has(rk)) return { resource, key };
      this.opts.onError?.({
        code: "bad_frame",
        msg: `frame for unsubscribed (${resource}, ${JSON.stringify(key)}) dropped`,
        resource,
        key,
      });
      return undefined;
    }

    if (key !== undefined) {
      // Key-only frame (old single-resource server). Look for an unambiguous match.
      const matches = this.subs.filter((s) => s.key === key);
      if (matches.length === 1) return matches[0];
      if (matches.length === 0) {
        this.opts.onError?.({
          code: "bad_frame",
          msg: `frame for unsubscribed key ${JSON.stringify(key)} dropped`,
          key,
        });
      } else {
        this.opts.onError?.({
          code: "bad_frame",
          msg: `key ${JSON.stringify(key)} is ambiguous across resources; frame dropped (server too old for multi-resource?)`,
          key,
        });
      }
      return undefined;
    }

    // No key at all — only unambiguous on a single-pair socket.
    if (this.subs.length === 1) return this.subs[0];
    this.opts.onError?.({
      code: "bad_frame",
      msg: "key-less frame on a multi-key subscription dropped (server too old for multi-key?)",
    });
    return undefined;
  }

  /** True when any wire row's seq is ahead of (or unknown to) its pair's local set. */
  private isBehind(
    wire: Array<{ resource: string; key: string; tid: string; seq: number }>,
  ): boolean {
    for (const { resource, key, tid, seq } of wire) {
      const rk = DurableSubscription.rkKey(resource, key);
      // A pair whose (re)connect snapshot has not arrived yet cannot be
      // judged — every instance would look "unseen" while the snapshot is
      // still in flight, and that snapshot supersedes this heartbeat anyway.
      if (this.pendingSnapshots.has(rk)) continue;
      const held = this.bySub.get(rk)?.get(tid);
      if (held === undefined || seq > held.seq) return true;
    }
    return false;
  }

  private rawRows(
    frame: Record<string, unknown>,
    resource: string,
    key: string,
  ): ProjectionRow[] {
    const out: ProjectionRow[] = [];
    for (const raw of (frame["rows"] as unknown[] | undefined) ?? []) {
      const r = this.toRow(raw, resource, key);
      if (r !== undefined) out.push(r);
    }
    return out;
  }

  private toRow(raw: unknown, resource: string, key: string): ProjectionRow | undefined {
    const r = raw as { instance_tid?: unknown; seq?: unknown; doc?: unknown };
    if (typeof r.instance_tid !== "string" || typeof r.seq !== "number") {
      return undefined;
    }
    return { resource, key, instanceTid: r.instance_tid, seq: r.seq, doc: r.doc };
  }
}
