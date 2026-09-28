// AuditClient — the app's audit feed (`/app/audit/list`, Manager).
//
// Covers control-plane changes to the app and to its docs, resources,
// files, folders and sources, plus refused access attempts
// (`action: "app.access.denied"` — pass `include_payload: true` to see the
// `required_level` that was missing).

import type { HttpCore } from "./http.js";

export type AuditTargetKind = "app" | "doc" | "resource" | "file" | "folder" | "app_source";

/** Filters, AND-combined. */
export interface AuditListInput {
  /** Exact `actor_user_tid` of a row (not a username). */
  actor?: string;
  action?: string;
  /** e.g. `"app.access"` for refusals, `"app.acl"` for ACL edits. */
  action_prefix?: string;
  target_kind?: AuditTargetKind;
  target_tid?: string;
  /** Window start, epoch ms. Default: 7 days ago. The window is at most 90 days. */
  since_ms?: number;
  /** Window end, epoch ms. Default: now. */
  until_ms?: number;
  /** 1–500, default 100 (clamped silently). */
  limit?: number;
  /** 0–100000 (clamped silently); use the returned `next_offset`. */
  offset?: number;
  /** Include `payload_json` (off by default; it can hold user content). */
  include_payload?: boolean;
}

/** One audit row; all keys are always present. */
export interface AuditRow {
  tid: string;
  /** Event time, epoch ms. */
  ts: number;
  actor_user_tid: string | null;
  actor_username: string | null;
  /** e.g. `"app.acl_set"`, `"app.access.denied"`. */
  action: string;
  target_kind: AuditTargetKind;
  target_tid: string | null;
  /** Reserved; currently always null. */
  target_path: string | null;
  /** Client IP when known; null on refusal rows by design. */
  source_ip: string | null;
  /** Reserved; currently always null. */
  request_id: string | null;
  /** Reserved; currently always null. */
  correlation_tid: string | null;
  /** `"success"` or `"failure"`. */
  result: string;
  /** Only with `include_payload`; `{redacted: true}` when an operator redacted the row. */
  payload_json: Record<string, unknown> | null;
}

export interface AuditListResult {
  /** Newest first. */
  rows: AuditRow[];
  /** Pass as `offset` for the next page; `null` on the last page. */
  next_offset: number | null;
}

export class AuditClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Read the audit feed (Manager). A window wider than 90 days is refused
   * with `audit_window_too_wide`.
   */
  list(input: AuditListInput = {}): Promise<AuditListResult> {
    return this.http.post<AuditListResult>("/app/audit/list", input);
  }
}
