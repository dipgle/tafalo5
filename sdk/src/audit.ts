// AuditClient — the per-tenant audit feed (`POST /app/audit/list`).
//
// Source of truth: crates/routes/src/audit.rs. This is the app owner's own
// window onto the platform audit log, as opposed to `/admin/audit/*`, which is
// platform-admin only and covers every tenant.
//
// The caller-supplied `app_tid` is BOTH the authorisation gate and the query
// scope: every branch of the underlying WHERE clause hard-binds to the tid
// that was just authorised, so there is no way to read another app's rows
// through this endpoint (audit.rs:425-431).
//
// ## Two reasons this is worth wiring up
//
// 1. **It is no longer only about the app row.** The feed resolves
//    CHILD-resource events — docs, resources, files, folders and app sources —
//    by joining each child's own `app_tid` (audit.rs:449-459). So
//    `target_kind` is not always `"app"`, and a doc deletion or a file upload
//    shows up here without the tenant needing platform-admin access.
//
// 2. **Permission REFUSALS are recorded.** When the permission gate turns
//    somebody away it writes a row: action `app.access.denied`,
//    `result: "failure"`, and `detail.required_level` naming the level the
//    caller lacked (auth.rs:190, :239, :245, :255). Before this existed,
//    `access_denied` was returned from the gate with no record anywhere — an
//    app owner could not see that anybody had tried.
//
//    Only identified callers are recorded: a request reaches the refusal
//    branch only with a valid session, a live non-banned account and a real
//    app. Anonymous, expired and banned callers fail earlier and are
//    deliberately NOT written, because they carry no actor to attribute and
//    one row per unauthenticated poll would drown the table the owner is
//    meant to read. What remains is rare and interesting, so it is recorded
//    every time — **no sampling and no dedupe**. That is a design decision,
//    not an oversight: one account probing the same endpoint over and over is
//    exactly the shape an owner needs to see, and collapsing repeats would
//    erase it. The repeat pattern IS the signal.
//
//    No `source_ip` is stored on these rows. At the gate layer there is no
//    socket peer, and the only thing reachable is a caller-supplied
//    `x-forwarded-for` header, which cannot be validated there
//    (auth.rs:248-253). A spoofable IP in an audit row is worse than an
//    absent one, so the field stays null rather than carrying a value an
//    investigation might trust.
//
// This is the single most valuable thing a tenant security dashboard can
// show, and — as of this SDK release — nothing else public documents that it
// exists. Filter for it with `action_prefix: "app.access"` (or the exact
// `action: "app.access.denied"`), and pass `include_payload: true` if you
// want `required_level`, which lives in the payload and is `null` without it.

import type { HttpCore } from "./http.js";

/**
 * Resource kinds that can appear as `target_kind`.
 *
 * `"app"` matches on the audit row's own `resource_tid`; the other five are
 * resolved by joining the child's `app_tid` (audit.rs:449-459). `null` is
 * possible on a row whose `resource_type` was never set.
 */
export type AuditTargetKind = "app" | "doc" | "resource" | "file" | "folder" | "app_source";

/** Filters for {@link AuditClient.list}. Every field is optional; supplied
 *  filters are AND-combined. */
export interface AuditListInput {
  /**
   * Actor filter. Matches `actor_tid` **exactly** (`audit.rs:462`) — so pass
   * the value a row reports as {@link AuditRow.actor_user_tid}, not a
   * username and not the other tid spelling. A row written for a legacy
   * `u_<uuid>` account stores that spelling verbatim, so filtering it by the
   * canonical `u-<uuid>` form silently returns nothing.
   */
  actor?: string;
  /** Exact-match on `action`. Compatible with `action_prefix`; both apply. */
  action?: string;
  /**
   * Prefix-match on `action`. The index still helps for short prefixes.
   * `"app.access"` isolates permission refusals; `"app.acl"` isolates ACL
   * edits.
   */
  action_prefix?: string;
  /** Restrict to one kind of target. */
  target_kind?: AuditTargetKind;
  /** Restrict to one target tid. */
  target_tid?: string;
  /**
   * Window start, epoch ms. Defaults to 7 days ago (audit.rs:339) — a bare
   * `list()` is a one-week feed, not everything.
   */
  since_ms?: number;
  /** Window end, epoch ms. Defaults to now. */
  until_ms?: number;
  /** Clamped to 1..=500; defaults to 100 (audit.rs:440). */
  limit?: number;
  /** Clamped to 0..=100000; defaults to 0 (audit.rs:441). */
  offset?: number;
  /**
   * Include `payload_json`. **Off by default** — tenant payloads can carry
   * user-supplied content, so it is opt-in.
   *
   * Required to read `detail.required_level` off a refusal row: without it
   * `payload_json` is `null` and the row tells you somebody was refused but
   * not what they were refused for.
   *
   * An operator can mark an individual row `redact: true` server-side, in
   * which case the payload comes back as `{redacted: true}` even with this
   * set (audit.rs:522-534).
   */
  include_payload?: boolean;
}

/**
 * One audit row. Thirteen keys, always all thirteen — the shape is stable
 * whether or not the underlying column exists.
 *
 * Three are **permanently null** in the current schema (audit.rs:550-553):
 * `target_path`, `request_id` and `correlation_tid`. They are emitted so the
 * response shape does not change when the columns arrive. Do not build a
 * correlation feature on them yet, and do not treat their nullness as
 * evidence about the event.
 */
export interface AuditRow {
  /** The audit row's own tid. */
  tid: string;
  /** Event time, epoch ms (the `created_at` column). */
  ts: number;
  /**
   * Acting user's tid, in the spelling `users.tid` actually holds — so a
   * legacy `u_<uuid>` actor stays joinable against the users table.
   */
  actor_user_tid: string | null;
  actor_username: string | null;
  /**
   * What happened, e.g. `"app.acl_set"`, `"app.acl_revoke"`,
   * `"app.access.denied"`. Stable strings — filter on these, not on prose.
   */
  action: string;
  /** See {@link AuditTargetKind}. Not always `"app"`. */
  target_kind: AuditTargetKind | null;
  target_tid: string | null;
  /** Always `null` — no such column yet. */
  target_path: null;
  /**
   * Client IP where one was resolvable. Always `null` on
   * `app.access.denied` rows, on purpose — see this module's header.
   */
  source_ip: string | null;
  /** Always `null` — no such column yet. */
  request_id: null;
  /** Always `null` — no such column yet. */
  correlation_tid: null;
  /** `"success"` or `"failure"`. Refusal rows are `"failure"`. */
  result: string;
  /**
   * The event's `detail` blob, or `null` unless `include_payload` was set.
   * `{redacted: true}` when an operator flagged the row.
   *
   * On an `app.access.denied` row this carries `required_level` (one of
   * `"owner" | "manager" | "designer" | "editor" | "reader"`) and `doc_tid`
   * for a doc-level refusal.
   */
  payload_json: Record<string, unknown> | null;
}

/** Result of {@link AuditClient.list}. */
export interface AuditListResult {
  /** Newest first (`ORDER BY created_at DESC`, audit.rs:467). */
  rows: AuditRow[];
  /**
   * Offset to pass back for the next page, or `null` when this is the last
   * one. The server only sets it when a FULL page came back and the next
   * offset is still inside the 100000 cap (audit.rs:493), so treating `null`
   * as "stop" is correct and saves a round-trip on the final page.
   */
  next_offset: number | null;
}

export class AuditClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Read this app's audit feed. **Manager** (`audit.rs:29`, `:431`).
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * Windowing: `since_ms` defaults to 7 days ago and `until_ms` to now. The
   * window may not exceed **90 days** per call — a wider one is refused with
   * `audit_window_too_wide` (audit.rs:380, cap at `:335`), thrown as a
   * `BadRequestError` whose `msg` names both your window and the limit. Rows
   * older than the retention TTL have already been swept, so paginate within
   * the window rather than widening it.
   *
   * `limit` is clamped to 1..=500 (default 100) and `offset` to 0..=100000,
   * **silently** — asking for 5000 rows returns 500 with no error and no
   * warning. Page with the returned `next_offset` rather than by comparing
   * `rows.length` against the limit you sent.
   *
   * Rows come back newest first.
   *
   * To build a security panel, query the refusals directly:
   *
   * ```ts
   * const { rows } = await tfl5.audit.list({
   *   action: "app.access.denied",
   *   include_payload: true,   // required for detail.required_level
   *   limit: 200,
   * });
   * ```
   */
  list(input: AuditListInput = {}): Promise<AuditListResult> {
    return this.http.post<AuditListResult>("/app/audit/list", input);
  }
}
