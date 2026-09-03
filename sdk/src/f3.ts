// F3Client — `/app/f3/*`. Encrypted file attachments bound to a doc.
//
// Every file is bound to a doc: read/write authorization runs against the
// doc's ACL (per-doc, falling back to app-level), and the file's encryption
// key derives from the doc's DEK (which derives from the per-app key in
// `app_keys`). The key never leaves the server — clients send/receive
// plaintext over HTTPS; the server encrypts/decrypts and proxies the
// storage backend (S3/local) on the fly.
//
// Source of truth: crates/routes/src/f3.rs. Endpoints:
//   POST /app/f3/upload      — multipart; Editor+ on the doc
//   POST /app/f3/edit        — multipart; Editor+ on the app, then the doc
//   POST /app/f3/download    — JSON in, RAW BYTES out; Reader+ on the doc
//   POST /app/f3/list        — JSON; Reader+ on the doc; metadata only
//   POST /app/f3/delete      — JSON; Editor+ on the doc + deletable ACL
//   POST /app/f3/access-log  — JSON; Manager on the app; audit trail
//   POST /app/f3/grant       — JSON; Editor+ on the app + caller must hold a grant
//   POST /app/f3/revoke      — JSON; Editor+ on the app
//   POST /app/f3/grants/list — JSON; Manager on the app
//
// See {@link F3Level} for what each security level actually does.
//
// Storage quota: `upload()` can now be refused on quota (`quota_app_max_storage`,
// HTTP 400) — see {@link F3Client.upload}'s doc comment for why that's new.

import type { HttpCore } from "./http.js";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * F3 security level. Mirrors the server's `f3_files.level` column
 * (f3.rs, `if !(1..=3).contains(&level)` — currently f3.rs:289 — validates
 * `1..=3`; there is no level 0 — every F3 file is encrypted). Numbers are
 * the wire values; use the named members so a reader doesn't have to
 * memorize which number means what.
 */
export enum F3Level {
  /**
   * Doc-derived DEK (HKDF from the app key). Any reader with doc access can
   * decrypt. No audit log is written on read — only on `delete`/`edit`.
   */
  Internal = 1,
  /**
   * Identical crypto to {@link Internal}, but EVERY open is written to
   * `f3_access_log` (f3.rs, the `if level >= 2 { write_access_log(...,
   * "read", ...) }` guard ahead of the backend read — currently f3.rs:536,
   * with the deny-path call at f3.rs:574). Use this when you need an audit
   * trail of who viewed the file, not just who could.
   */
  Confidential = 2,
  /**
   * Sealed per-grantee: the file's DEK is random (not derivable from the
   * doc/app key at all) and stored once per grantee as an X25519-sealed
   * envelope in `f3_grants` (f3.rs:262-271, 336-353). Doc ACL is NOT
   * sufficient to read or edit a level-3 file — the caller additionally
   * needs their own unrevoked row in `f3_grants` (granted via {@link
   * F3Client.grant}). The uploader is auto-granted at upload time.
   */
  TopSecret = 3,
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * F3 file metadata. The exact field set differs slightly by endpoint —
 * see each field's comment (verified against f3.rs):
 *   upload → `{ tid, level, name, size, storage_backend }`      (f3.rs:359-369)
 *   edit   → `{ tid, level, name, size, updated_at }`            (f3.rs:1121-1131)
 *   list   → `{ tid, level, name, mime, size, author, created_at }` (f3.rs:569-588)
 */
export interface F3FileMeta {
  tid: string;
  level: F3Level;
  name: string;
  /** Present on `list()` rows only. */
  mime?: string | null;
  /** Plaintext size in bytes. */
  size: number;
  /** Present on `list()` rows only. */
  author?: string;
  /** Present on `list()` rows only. */
  created_at?: number;
  /** Present on `edit()`'s result only. */
  updated_at?: number;
  /** Present on `upload()`'s result only. */
  storage_backend?: string;
}

export interface F3UploadInput {
  /** App that owns the doc. */
  app_tid: string;
  /** Doc the file is attached to. */
  doc_tid: string;
  /** Security level. Defaults to {@link F3Level.Internal} if omitted. */
  level?: F3Level;
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
  /** Decrypted plaintext bytes. */
  bytes: ArrayBuffer;
  /** Filename parsed from the `Content-Disposition` header (f3.rs:503-506
   *  sanitizes it server-side: CR/LF/quote/backslash become `_`). */
  filename: string;
  /** MIME type from `Content-Type`, when the server had one on file. */
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
// Raw-bytes fetch for /app/f3/download
// ---------------------------------------------------------------------------
//
// HttpCore.post()/postForm() (http.ts) both unconditionally unwrap the
// response through `res.json()`. That's correct for every other endpoint,
// but /app/f3/download (f3.rs:381-511) streams raw plaintext bytes with a
// `Content-Disposition: attachment` header on success — never JSON. Calling
// `res.json()` on that body throws a SyntaxError, which `unwrap()`'s catch
// swallows into a bare `undefined` (`return undefined as T` when `res.ok`),
// silently discarding the file. This isn't hypothetical: the INTERNAL
// reference SDK's `download()` does exactly `http.post<ArrayBuffer>(...)`
// and inherits this bug (its own http.ts has the identical `unwrap()`), so
// it resolves `undefined` instead of the file's bytes.

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * F3Client — secure per-doc encrypted file attachments.
 *
 * All endpoints are scoped to `/app/f3/*`. `upload`/`edit`/`list` take
 * `app_tid` explicitly (and `list` also `doc_tid`); the other endpoints
 * (`download`, `delete`, `access-log`, `grant`, `revoke`, `grants/list`)
 * derive `app_tid` server-side from the F3 file row, so we don't send it.
 */
export class F3Client {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload a new encrypted attachment bound to `doc_tid`. Requires Editor+
   * on the doc.
   *
   * Multipart field order (f3.rs:161-236): the handler streams parts one at
   * a time and, on hitting the `file` part, requires `app_tid` AND `doc_tid`
   * to have ALREADY been read — either missing at that point fails with
   * `"app_tid/doc_tid must precede file in multipart"` (f3.rs:197-202).
   * `level` and `name` have no such constraint (both are only read after
   * the whole stream finishes), but this method always sends them in the
   * conventional safe order `app_tid → doc_tid → level → name → file`
   * anyway.
   *
   * Can now be refused on storage quota: `enforce_storage_delta` (f3.rs:348)
   * charges this upload's CIPHERTEXT bytes against `apps.used_storage`,
   * checked BEFORE the bytes reach the storage backend, and throws
   * `BadRequestError` (`code: "quota_app_max_storage"`, HTTP 400) over the
   * cap. Before that wiring, F3 bytes never touched `used_storage` and an
   * upload could not fail on quota at all — this is a genuinely new
   * refusal a caller may not be handling yet. The per-file 100 MB cap
   * (`MAX_FILE_BYTES`) is unrelated and unchanged; quota is an additional
   * gate, not a replacement.
   */
  async upload(input: F3UploadInput): Promise<F3FileMeta> {
    const form = new FormData();
    form.append("app_tid", input.app_tid);
    form.append("doc_tid", input.doc_tid);
    if (input.level != null) form.append("level", String(input.level));
    if (input.name) form.append("name", input.name);
    // `as BlobPart`: TS 5.7+ types `Uint8Array<ArrayBufferLike>` as
    // incompatible with `BlobPart` over the `SharedArrayBuffer` edge, but a
    // plain Uint8Array is a valid Blob part at runtime.
    const blob = input.file instanceof Blob ? input.file : new Blob([input.file as BlobPart]);
    const filename =
      input.filename ?? input.name ?? (input.file instanceof File ? input.file.name : "file");
    form.append("file", blob, filename);
    return this.http.postForm<F3FileMeta>("/app/f3/upload", form);
  }

  /**
   * Replace the bytes of an existing F3 file. Level-3 files keep their DEK
   * (recovered from the caller's existing grant) so every pre-existing
   * grant stays valid after the edit (f3.rs:1022-1046).
   *
   * Auth is two-step: Editor on the APP is checked as soon as the `file`
   * part arrives (f3.rs:955-963), then Editor on the resolved DOC is
   * re-checked once `doc_tid` is known (f3.rs:1020) — the second check can
   * still refuse a caller who passed the first (doc-level `noaccess`).
   *
   * Multipart field order: only `app_tid` must precede `file`
   * (f3.rs:955-957, `"app_tid must precede file in multipart"`); `f3_tid`
   * and `name` are read after the stream finishes and have no ordering
   * constraint (unlike `upload`, which also requires `doc_tid` up front —
   * `edit` has no `doc_tid` field at all; it's resolved from the file row).
   * This method sends `app_tid → f3_tid → name → file` regardless.
   */
  async edit(input: F3EditInput): Promise<F3FileMeta> {
    const form = new FormData();
    form.append("app_tid", input.app_tid);
    form.append("f3_tid", input.f3_tid);
    if (input.name) form.append("name", input.name);
    const blob = input.file instanceof Blob ? input.file : new Blob([input.file as BlobPart]);
    const filename =
      input.filename ?? input.name ?? (input.file instanceof File ? input.file.name : "file");
    form.append("file", blob, filename);
    return this.http.postForm<F3FileMeta>("/app/f3/edit", form);
  }

  /**
   * Download a file's decrypted bytes. Requires Reader+ on the doc.
   *
   * The server streams RAW plaintext bytes with a `Content-Disposition:
   * attachment` header on success — not a JSON envelope (f3.rs:499-511) —
   * so this uses `HttpCore.postRaw()`, which skips the JSON unwrap that would
   * otherwise consume the body and resolve `undefined`.
   *
   * Level 2+ writes an access-log row on every open (`"read"`, granted:
   * true). Level 3 requires the caller to hold an unrevoked grant; a
   * missing grant is audited as a denial and rejected with the SAME opaque
   * `AccessDeniedError` a permissionless caller would get (no info leak
   * about whether a grant exists — f3.rs:458-476).
   */
  async download(f3Tid: string): Promise<F3DownloadResult> {
    const { bytes, filename, mimeType } = await this.http.postRaw("/app/f3/download", {
      f3_tid: f3Tid,
    });
    return { bytes, filename: filename ?? "file", mimeType };
  }

  /** List F3 attachments for a doc. Metadata only — no file bytes. Requires
   *  Reader+ on the doc. */
  list(appTid: string, docTid: string): Promise<F3FileMeta[]> {
    return this.http.post<F3FileMeta[]>("/app/f3/list", {
      app_tid: appTid,
      doc_tid: docTid,
    });
  }

  /**
   * Soft-delete a file. Requires Editor+ on the doc AND the doc's
   * `deletable` ACL (f3.rs, `if !doc_acl.is_deletable_by(&perm)` — currently
   * f3.rs:732) — Editor alone is not sufficient if the doc's ACL restricts
   * who may delete.
   */
  del(f3Tid: string): Promise<void> {
    return this.http.post("/app/f3/delete", { f3_tid: f3Tid }).then(() => undefined);
  }

  /**
   * Retrieve the access audit log for a file. Requires Manager on the app.
   * Returns up to 500 rows, most-recent first.
   */
  accessLog(f3Tid: string): Promise<F3AccessLogEntry[]> {
    return this.http.post<F3AccessLogEntry[]>("/app/f3/access-log", { f3_tid: f3Tid });
  }

  /**
   * Grant a user access to a level-3 file. Requires Editor+ on the app AND
   * that the CALLER already holds an unrevoked grant on this file
   * themselves (f3.rs:737-749, `AccessDeniedError` if not — you can't share
   * access you don't have). No-op / rejected as a `BadRequestError` on
   * level-1/2 files (grants are meaningless there).
   */
  grant(
    f3Tid: string,
    granteeUserTid: string,
  ): Promise<{ f3_tid: string; grantee_user_tid: string; granted_at: number }> {
    return this.http.post<{ f3_tid: string; grantee_user_tid: string; granted_at: number }>(
      "/app/f3/grant",
      { f3_tid: f3Tid, grantee_user_tid: granteeUserTid },
    );
  }

  /**
   * Revoke a user's access to a level-3 file (soft-revoke; stamps
   * `revoked_at`). Requires Editor+ on the app.
   *
   * Throws `BadRequestError` (code `"bad_request"`) if the grantee has no
   * active grant — the server replies `result:false` WITHOUT a `code`
   * field in that case (f3.rs:842-848), and `HttpCore.unwrap()` still
   * treats any `result:false` as an error regardless of `code` being
   * present. This differs from the internal reference SDK's doc comment,
   * which describes a non-throwing `{ revoked: false }` outcome — that
   * outcome does not actually happen; both SDKs share the same throw-on-
   * `result:false` transport.
   */
  revoke(f3Tid: string, granteeUserTid: string): Promise<{ revoked: true }> {
    return this.http.post<{ revoked: true }>("/app/f3/revoke", {
      f3_tid: f3Tid,
      grantee_user_tid: granteeUserTid,
    });
  }

  /**
   * List all grant rows for a file (including revoked ones — check
   * `revoked_at != null`). Requires Manager on the app.
   */
  grantsList(f3Tid: string): Promise<F3GrantRow[]> {
    return this.http.post<F3GrantRow[]>("/app/f3/grants/list", { f3_tid: f3Tid });
  }
}
