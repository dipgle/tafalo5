// F3Client — `/app/f3/*`. Encrypted attachments bound to one doc.
//
// Files are bound to a doc; the encryption key derives server-side from the
// doc DEK (which derives from the per-app key). Clients always send/receive
// plaintext over HTTPS — the server handles crypto transparently.
//
// Levels:
//   1 = internal     — doc-derived DEK, accessible to doc readers.
//   2 = confidential — same crypto + per-access audit log.
//   3 = top-secret   — per-grantee key envelope; caller needs an
//                      unrevoked grant to read or edit.

import type { HttpCore } from "./http.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Metadata returned by upload, edit, and list. */
export interface F3FileMeta {
  tid: string;
  level: 1 | 2 | 3;
  name: string;
  mime?: string | null;
  /** Plaintext size in bytes. */
  size: number;
  author?: string;
  created_at?: number;
  updated_at?: number;
  storage_backend?: string;
}

export interface F3UploadInput {
  /** App that owns the doc. */
  app_tid: string;
  /** Doc the file is attached to. */
  doc_tid: string;
  /**
   * Security level. Defaults to `1`.
   * - `1` internal  — doc-derived DEK.
   * - `2` confidential — same crypto + per-access audit.
   * - `3` top-secret — per-grantee envelope (requires a prior grant to read).
   */
  level?: 1 | 2 | 3;
  /** Display name for the file. Falls back to the File's own name. */
  name?: string;
  /** The binary payload. */
  file: Blob | Uint8Array;
  /** Filename override; defaults to `input.name` or `"file"`. */
  filename?: string;
}

export interface F3EditInput {
  /** App that owns the file. */
  app_tid: string;
  /** Existing F3 file tid to overwrite. */
  f3_tid: string;
  /** Optional rename; omit to keep the current name. */
  name?: string;
  /** New file content. */
  file: Blob | Uint8Array;
  filename?: string;
}

/** Result of {@link F3Client.download}. */
export interface F3DownloadResult {
  /** Decrypted plaintext. */
  bytes: ArrayBuffer;
  /** The same bytes as a Blob. */
  blob: Blob;
  filename?: string;
  mimeType?: string;
}

export interface F3AccessLogEntry {
  tid: string;
  user_tid: string;
  action: string;
  granted: boolean;
  client_ip?: string | null;
  user_agent?: string | null;
  accessed_at: number;
}

export interface F3GrantRow {
  grantee_user_tid: string;
  granted_by: string;
  granted_at: number;
  revoked_at?: number | null;
  revoked_by?: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * F3Client — secure per-doc encrypted file attachments.
 *
 * All endpoints are scoped to `/app/f3/*`. The http layer auto-injects
 * `app_tid` for endpoints that need it; for endpoints that derive `app_tid`
 * server-side from the F3 file row (`download`, `delete`, `access-log`,
 * `grant`, `revoke`, `grants/list`) we do NOT send it explicitly.
 */
export class F3Client {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload a new encrypted attachment bound to `doc_tid`.
   * Multipart — equivalent of the raw form with fields ordered:
   * `app_tid` → `doc_tid` → `level` → `name` → `file`.
   */
  async upload(input: F3UploadInput): Promise<F3FileMeta> {
    const form = new FormData();
    form.append("app_tid", input.app_tid);
    form.append("doc_tid", input.doc_tid);
    if (input.level != null) form.append("level", String(input.level));
    if (input.name) form.append("name", input.name);
    const blob =
      input.file instanceof Blob ? input.file : new Blob([input.file as BlobPart]);
    const filename =
      input.filename ?? input.name ?? (input.file instanceof File ? input.file.name : "file");
    form.append("file", blob, filename);
    return this.http.postForm<F3FileMeta>("/app/f3/upload", form);
  }

  /**
   * Replace the bytes of an existing F3 file.
   * Level-3 files preserve their DEK (and all existing grants) after edit.
   * Multipart — fields ordered: `app_tid` → `f3_tid` → `name` → `file`.
   */
  async edit(input: F3EditInput): Promise<F3FileMeta> {
    const form = new FormData();
    form.append("app_tid", input.app_tid);
    form.append("f3_tid", input.f3_tid);
    if (input.name) form.append("name", input.name);
    const blob =
      input.file instanceof Blob ? input.file : new Blob([input.file as BlobPart]);
    const filename =
      input.filename ?? input.name ?? (input.file instanceof File ? input.file.name : "file");
    form.append("file", blob, filename);
    return this.http.postForm<F3FileMeta>("/app/f3/edit", form);
  }

  /**
   * Download a file's plaintext. Level ≥ 2 also writes an access-log row;
   * level 3 needs an unrevoked grant (a missing grant is refused like any
   * other access denial). `filename` comes from the response header, which
   * a browser can only read on the API's own origin.
   */
  async download(f3Tid: string): Promise<F3DownloadResult> {
    const r = await this.http.postBlobNamed("/app/f3/download", { f3_tid: f3Tid });
    return { bytes: await r.blob.arrayBuffer(), blob: r.blob, filename: r.filename, mimeType: r.mimeType };
  }

  /** List F3 attachments for a doc. Metadata only — no file bytes. */
  list(appTid: string, docTid: string): Promise<F3FileMeta[]> {
    return this.http.post<F3FileMeta[]>("/app/f3/list", {
      app_tid: appTid,
      doc_tid: docTid,
    });
  }

  /**
   * Soft-delete a file (Editor on the doc + deletable ACL check).
   * The server derives `app_tid` from the file row.
   */
  del(f3Tid: string): Promise<void> {
    return this.http.post("/app/f3/delete", { f3_tid: f3Tid }).then(() => undefined);
  }

  /**
   * Retrieve the access audit log for a file (Manager on app).
   * Returns up to 500 rows, most-recent first.
   */
  accessLog(f3Tid: string): Promise<F3AccessLogEntry[]> {
    return this.http.post<F3AccessLogEntry[]>("/app/f3/access-log", { f3_tid: f3Tid });
  }

  /**
   * Grant a user access to a level-3 file.
   * Caller must be Editor on the app AND already hold an unrevoked grant.
   * No-op on level-1/2 files (rejected by the server).
   */
  grant(f3Tid: string, granteeUserTid: string): Promise<{ f3_tid: string; grantee_user_tid: string; granted_at: number }> {
    return this.http.post<{ f3_tid: string; grantee_user_tid: string; granted_at: number }>(
      "/app/f3/grant",
      { f3_tid: f3Tid, grantee_user_tid: granteeUserTid },
    );
  }

  /**
   * Revoke a user's access to a level-3 file (soft-revoke). Throws when the
   * user holds no active grant.
   */
  revoke(f3Tid: string, granteeUserTid: string): Promise<{ revoked?: boolean }> {
    return this.http.post<{ revoked?: boolean }>("/app/f3/revoke", {
      f3_tid: f3Tid,
      grantee_user_tid: granteeUserTid,
    });
  }

  /**
   * List all grant rows for a file (Manager on the app).
   * Includes revoked rows (check `revoked_at != null`).
   */
  grantsList(f3Tid: string): Promise<F3GrantRow[]> {
    return this.http.post<F3GrantRow[]>("/app/f3/grants/list", { f3_tid: f3Tid });
  }
}
