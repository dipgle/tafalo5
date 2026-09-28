// SiteClient — `/app/site/*`, the content-addressed site engine.
//
// This is the recommended way to author and publish an app's front-end.
// You edit a DRAFT (put/delete), then `publish()` freezes the draft into an
// immutable snapshot and makes it live atomically; `rollback()` makes any
// earlier snapshot live again. Identical bytes are stored once.
//
// Once an app has published through the site engine, the site engine is what
// visitors see: bundles (`tfl5.bundle`) and files written to the release
// stage (`tfl5.files`) are no longer served for that app.
//
// All methods need Manager on the scoped app.

import type { HttpCore } from "./http.js";

export interface SiteEntry {
  path: string;
  entry_kind: "file" | "page" | "dir";
  blob_sha: string | null;
  size: number;
  mime: string | null;
}

export interface SiteSnapshot {
  id: string;
  note: string | null;
  parent_id: string | null;
  entry_count: number;
  total_bytes: number;
  created_by: string;
  created_at: number;
  is_live: boolean;
  is_draft: boolean;
}

export interface SiteFileVersion {
  snapshot_id: string;
  note: string | null;
  created_at: number;
  blob_sha: string;
}

export interface SitePutInput {
  /** Path inside the site, no leading slash, e.g. `"index.html"`. */
  path: string;
  /** `"file"` (default) or `"page"` (a no-code page rendered by the server). */
  kind?: "file" | "page";
  /** Give exactly one of `text` or `base64`. Max 50 MiB. */
  text?: string;
  base64?: string;
  mime?: string;
}

export interface SiteImportResult {
  /** `true` when a snapshot was created and made live. */
  imported: boolean;
  snapshot_id: string | null;
  reason: "already_on_engine" | "no_files" | "too_many_files" | null;
  file_count: number;
  truncated: boolean;
  /** Paths that could not be read and were left out. */
  skipped: string[];
}

export class SiteClient {
  constructor(private readonly http: HttpCore) {}

  /** Write one file into the draft. `deduped` is true when the bytes already existed. */
  async put(input: SitePutInput): Promise<{ snapshot_id: string; blob_sha: string; size: number; deduped: boolean }> {
    const r = await this.http.post<{ snapshot_id: string; blob_sha: string; size: number; deduped: boolean }>(
      "/app/site/put",
      {
        path: input.path,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.text !== undefined ? { content_text: input.text } : {}),
        ...(input.base64 !== undefined ? { content_base64: input.base64 } : {}),
        ...(input.mime !== undefined ? { mime: input.mime } : {}),
      },
    );
    return { snapshot_id: r.snapshot_id, blob_sha: r.blob_sha, size: r.size, deduped: r.deduped };
  }

  /** Remove a path from the draft. Resolves `false` if it was not there. */
  async delete(path: string): Promise<boolean> {
    const r = await this.http.post<{ removed: boolean }>("/app/site/delete", { path });
    return r.removed;
  }

  /** Entries of the open draft (or of the live snapshot when no draft is open). */
  async list(): Promise<SiteEntry[]> {
    const r = await this.http.post<{ entries: SiteEntry[] }>("/app/site/list", {});
    return r.entries;
  }

  /** Read one draft file as base64; `null` when the path is not in the draft. */
  async get(path: string): Promise<string | null> {
    const r = await this.http.post<{ found: boolean; content_base64?: string }>("/app/site/get", { path });
    return r.found ? (r.content_base64 ?? "") : null;
  }

  /**
   * Publish the draft: it becomes the live site and a fresh draft opens.
   * Refused (code `bad_request`) when the draft is empty.
   * Resolves the id of the new live snapshot.
   */
  async publish(note?: string): Promise<string> {
    const r = await this.http.post<{ live_snapshot: string }>(
      "/app/site/publish",
      note !== undefined ? { note } : {},
    );
    return r.live_snapshot;
  }

  /** Make an earlier published snapshot live again (not the open draft). */
  async rollback(snapshotId: string): Promise<void> {
    await this.http.post("/app/site/rollback", { snapshot_id: snapshotId });
  }

  /** All snapshots, newest first. */
  async history(): Promise<SiteSnapshot[]> {
    const r = await this.http.post<{ snapshots: SiteSnapshot[] }>("/app/site/history", {});
    return r.snapshots;
  }

  /** Every snapshot that held `path`, newest first. */
  async fileHistory(path: string): Promise<SiteFileVersion[]> {
    const r = await this.http.post<{ versions: SiteFileVersion[] }>("/app/site/file-history", { path });
    return r.versions;
  }

  /** Read a stored blob by sha (only blobs this app's snapshots reference). */
  async blob(sha: string): Promise<string | null> {
    const r = await this.http.post<{ found: boolean; content_base64?: string }>("/app/site/blob", { sha });
    return r.found ? (r.content_base64 ?? "") : null;
  }

  /**
   * One-time import of the app's currently served front-end (active bundle,
   * else release-stage files) into the site engine, made live immediately.
   * Idempotent: returns `reason: "already_on_engine"` afterwards.
   */
  async importCurrent(): Promise<SiteImportResult> {
    const r = await this.http.post<SiteImportResult>("/app/site/backfill", {});
    return {
      imported: r.imported,
      snapshot_id: r.snapshot_id,
      reason: r.reason,
      file_count: r.file_count,
      truncated: r.truncated,
      skipped: r.skipped,
    };
  }

  /**
   * URL that renders a draft file (for an `<iframe>` preview). It is not a
   * JSON endpoint: errors come back as plain text with a 4xx/5xx status.
   * The browser must carry the Manager's session cookie.
   */
  previewUrl(path = "index.html", appTid?: string): string {
    return this.http.urlFor("/app/site/preview", { app_tid: appTid ?? this.http.appId, path });
  }
}
