// FilesClient — `/app/file/*` + `/app/folder/*`.
//
// Uploads are multipart only (the server persists binaries straight from
// the multipart stream; never base64-in-JSON). Each part is a (`path`,
// `file`) pair and the request is repeatable for batch upload.
//
// ── Size limits — four DIFFERENT numbers, don't merge them ───────────────
// Constants named below are anchors: grep the symbol, not the line.
//
//   1. Per-file upload cap — 52,428,800 B (50 MiB).
//      `crates/routes/src/file/mod.rs` `MAX_UPLOAD_BYTES` (:84). Checked on
//      the DECODED bytes of each multipart part. Refusal code
//      `file_too_large`. (Raised 10 MiB → 50 MiB on 2026-08-26; any SDK doc
//      still saying "10 MB" for an upload is stale.)
//   2. Whole-REQUEST body cap — 104,857,600 B (100 MiB).
//      `file/mod.rs` `UPLOAD_REQ_CAP` (:327), applied as an axum
//      `DefaultBodyLimit` layer on `/app/file/upload`. The arithmetic a
//      caller actually meets: ONE 50 MiB file per request fits (with room
//      for the multipart envelope); TWO do not; hundreds of ordinary assets
//      are unaffected. The refusal for the "two" case is a size refusal
//      naming this cap — code `upload_request_too_large`, produced by
//      `multipart_read_error` (`file/mod.rs:372-380`) — NOT a parse error.
//      That distinction is load-bearing: the layer cuts the stream before
//      the per-file check can run, and the raw `MultipartError` reads as
//      "malformed multipart" for every cause it has, which historically had
//      people rebuilding archives that were never broken.
//   3. `/app/file/save` (the JSON/base64 write alternative to multipart)
//      body cap — 74,099,368 B. `file/mod.rs` `SAVE_JSON_REQ_CAP` (:346),
//      derived as `MAX_UPLOAD_BYTES / 3 * 4 + 4 MiB` because base64 costs
//      4/3. The handler still refuses on the DECODED length against the
//      50 MiB per-file cap. Base64-in-JSON keeps the encoded body, the
//      parsed string and the decoded bytes live at once — multipart is the
//      cheap path and the one to prefer at this size. Not wrapped by this
//      client; reach it with `tfl5.raw("/app/file/save", …)` if you must.
//   4. `/app/file/get` READ refusal — over 10,485,760 B (10 MiB).
//      `crates/routes/src/file/json_store.rs` `MAX_JSON_GET_BYTES` (:55).
//      This is a SEPARATE number from the 50 MiB upload cap and it did not
//      move with it: a file this client can upload can be too large to read
//      back through the JSON get route. Fetch those as bytes (public serve
//      or `signUrl()`), not through `/app/file/get`.
//
// ── The `stage` field on mutating ops ────────────────────────────────────
// `rename` / `del` / `folder/create` (and `file/acl-set`) resolve their
// target stage through `parse_mutating_stage`
// (`crates/routes/src/file/storage.rs:55`), which is NOT symmetric with the
// write path's `parse_write_stage`:
//   * default (no env override): an omitted `stage` runs on the LIVE
//     (release) stage;
//   * with `TFL5_STRICT_WRITE_STAGE=1`: an omitted `stage` silently
//     RETARGETS to the draft/test stage — the live file stays put and
//     nothing errors ("delete did nothing").
// Every method below therefore sends `stage: "release"` EXPLICITLY, so this
// client behaves identically whichever way the operator has set that flag.
// Do not remove those literals to "clean up" the bodies.
//
// ── `warnings` on release-stage writes ───────────────────────────────────
// Four mutating file routes — `/app/file/upload`, `/app/file/save`,
// `/app/file/del`, `/app/file/rename` — now answer with an ADDITIVE
// top-level `warnings` array (a sibling of `data`, omitted when empty) when
// `stage=release` and the app has a live site-engine snapshot. See
// `FileWriteWarning`. Source: `file/storage.rs` `snapshot_shadow_warning`
// (:134-177).

import type { HttpCore } from "./http.js";

export interface FileEntry {
  id?: string;
  path?: string;
  name?: string;
  size?: number;
  [k: string]: unknown;
}

/** One row as `upload()` reports it back (`file/mod.rs:792-800`). */
export interface UploadedFile {
  tid: string;
  path: string;
  /** Always `"release"` for this client — see the module note on `stage`. */
  stage: string;
  size: number;
  mime: string | null;
  parent_tid: string | null;
  /** The original multipart filename, when the part carried one. */
  original?: string | null;
  [k: string]: unknown;
}

export interface UploadPart {
  /** Logical destination path/folder within the app's file tree. */
  path: string;
  /** The binary. In the browser a File/Blob; in Node a Blob/Uint8Array. */
  file: Blob | Uint8Array;
  /** Optional filename override (defaults to the File's name or "file"). */
  filename?: string;
}

/**
 * A write that SUCCEEDED but will not be SERVED.
 *
 * Emitted when a release-stage file write lands on an app that serves a
 * published site-engine snapshot. Serve order is snapshot → bundle → file
 * stage (`crates/routes/src/public.rs:646-654`, and the snapshot branch
 * returns unconditionally), so once `apps.live_snapshot` is set — which is
 * exactly what "Import existing site" / `site.backfill()` does — the legacy
 * `public/` tree stops being consulted at all. The row is written, the bytes
 * are written, the envelope says `result:true`, and the visitor keeps seeing
 * the snapshot. That is a silent failure with a very long fuse: a CI job
 * publishing a customer's site can report success for weeks.
 *
 * DO NOT DROP THIS. If you see it, the change reached storage but not
 * visitors — republish through the site engine (`site.put()` then
 * `site.publish()`), or stop writing to the file tier for this app.
 *
 * Under `TFL5_REFUSE_SHADOWED_FILE_WRITE=1` the same condition is not a
 * warning but an HTTP 409 refusal carrying this same `code`, which the
 * transport raises as a `Tfl5Error` — so a caller that handles both the
 * warning and the error code is correct on either setting.
 */
export interface FileWriteWarning {
  code: "file_write_shadowed_by_snapshot";
  /** Human-readable explanation, naming the snapshot id. Reword-unstable —
   *  branch on `code`, never on this. */
  msg: string;
  /** The `apps.live_snapshot` id that is winning at serve time. */
  live_snapshot: string;
}

/** Envelope siblings every mutating file op may carry. */
export interface FileWriteEnvelope {
  /** Present ONLY when non-empty. See {@link FileWriteWarning}. */
  warnings?: FileWriteWarning[];
}

/** `del()` result — `file/mod.rs:1635-1642` plus the envelope's `warnings`. */
export interface FileDeleteResult extends FileWriteEnvelope {
  /** Bytes returned to the app's storage quota. */
  freed: number;
  is_dir: boolean;
  /** Tid of the row that was trashed. */
  tid: string;
  /** Epoch-ms the soft-delete was recorded. */
  trashed_at: number;
}

/**
 * `upload()` result.
 *
 * `data` on this route is a bare ARRAY of rows, so — unlike `del()` and
 * `rename()`, whose payloads are objects that spread into the result — the
 * rows live under `files` and `warnings` sits beside them.
 */
export interface FileUploadResult extends FileWriteEnvelope {
  /** The rows the server actually wrote, in request order. */
  files: UploadedFile[];
}

/** `rename()` result — `file/mod.rs:2253-2259` plus `warnings`. */
export interface FileRenameResult extends FileWriteEnvelope {
  tid: string;
  old_path: string;
  path: string;
  stage: string;
  parent_tid: string | null;
}

export class FilesClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload one or more files in a single multipart request.
   *
   * Size limits: one file ≤ 52,428,800 B (50 MiB) and the whole request
   * ≤ 104,857,600 B (100 MiB) — so a single max-size file fits and two do
   * not. See the module header for all four caps and for which refusal you
   * get from which layer.
   *
   * Returns `{files, warnings?}`. NOTE — the wire shape of `data` here is a
   * bare ARRAY: the handler answers `{result:true, data:[…]}` (`file/mod.rs`,
   * anchor `"data": uploaded,`), which this method exposes as `files`. It
   * previously declared `{file: FileEntry[]}`, a shape the server has never
   * sent — `res.file` was always `undefined`.
   *
   * ⚠ The `warnings` sibling IS surfaced here, and that is why the return is
   * an object rather than the bare array. The handler puts `warnings` at the
   * ENVELOPE top level beside `data` (`file/mod.rs`, anchor
   * `out["warnings"] = json!([w]);`), so `HttpCore.postForm()` — which
   * unwraps `data` — would drop it, and a write that stored bytes nobody will
   * ever be served would look like a clean success. This method reads the
   * whole envelope through `postFormFull()` instead, matching `del()` and
   * `rename()`. See {@link FileWriteWarning} for what to do when you get one.
   */
  async upload(parts: UploadPart | UploadPart[]): Promise<FileUploadResult> {
    const list = Array.isArray(parts) ? parts : [parts];
    const form = new FormData();
    for (const p of list) {
      form.append("path", p.path);
      // `as BlobPart`: TS 5.7+ types `Uint8Array<ArrayBufferLike>` as
      // incompatible with `BlobPart` over the `SharedArrayBuffer` edge, but a
      // plain Uint8Array is a valid Blob part at runtime.
      const blob =
        p.file instanceof Blob ? p.file : new Blob([p.file as BlobPart]);
      const name = p.filename ?? (p.file instanceof File ? p.file.name : "file");
      form.append("file", blob, name);
    }
    const env = await this.http.postFormFull<{
      data?: UploadedFile[];
      warnings?: FileWriteWarning[];
    }>("/app/file/upload", form);
    return {
      files: env.data ?? [],
      ...(env.warnings ? { warnings: env.warnings } : {}),
    };
  }

  list(path?: string): Promise<FileEntry[]> {
    return this.http.post<FileEntry[]>("/app/file/list", path ? { path } : {});
  }

  /**
   * Mint a short-lived signed URL for a file, keyed by its logical `path`
   * (the same `path` used at upload). Returns a relative `signed_url`
   * (`/_signed/<token>`) plus its expiry. The token defaults to a 5-minute
   * TTL (server cap: 1 hour), so mint on-demand at view time rather than
   * persisting the URL.
   *
   * Caller must pass the file's row ACL at mint time; Aggregate-binding
   * callers are rejected (`pii_aggregate_only`).
   *
   * This is also the way to hand out a file too large for
   * `/app/file/get`'s 10 MiB read cap — a signed URL streams through the
   * public serve path instead.
   */
  signUrl(
    path: string,
    opts: { expires_in_sec?: number } = {},
  ): Promise<{ signed_url: string; expires_at: number; cache_seconds: number }> {
    return this.http.post<{ signed_url: string; expires_at: number; cache_seconds: number }>(
      "/app/file/sign-url",
      { path, ...opts },
    );
  }

  /**
   * Rename / move a file row on the LIVE (release) stage.
   *
   * `stage: "release"` is sent explicitly — see the module header. Without
   * it, an operator running `TFL5_STRICT_WRITE_STAGE=1` would have this
   * rename silently retarget the draft stage and the live file would stay
   * where it was, with no error.
   *
   * May return `warnings` — a rename that succeeded but is shadowed by a
   * live snapshot. See {@link FileWriteWarning}.
   */
  async rename(id: string, name: string): Promise<FileRenameResult> {
    const env = await this.http.postFull<{
      data?: Partial<FileRenameResult>;
      warnings?: FileWriteWarning[];
    }>("/app/file/rename", { id, name, stage: "release" });
    return { ...(env.data as FileRenameResult), ...(env.warnings ? { warnings: env.warnings } : {}) };
  }

  /**
   * Soft-delete (moves to trash) on the LIVE (release) stage.
   *
   * `stage: "release"` is sent explicitly — see the module header and
   * {@link rename}: an omitted `stage` is the difference between deleting
   * the live file and silently deleting nothing.
   *
   * May return `warnings`. See {@link FileWriteWarning}.
   */
  async del(id: string): Promise<FileDeleteResult> {
    const env = await this.http.postFull<{
      data?: Partial<FileDeleteResult>;
      warnings?: FileWriteWarning[];
    }>("/app/file/del", { id, stage: "release" });
    return { ...(env.data as FileDeleteResult), ...(env.warnings ? { warnings: env.warnings } : {}) };
  }

  /**
   * Restore a trashed row.
   *
   * Deliberately sends NO `stage`: `/app/file/restore` does not route
   * through `parse_mutating_stage` — it restores the row to the stage the
   * row was trashed from — so a `stage` literal here would be noise
   * pretending to be a guarantee.
   */
  restore(id: string): Promise<void> {
    return this.http.post("/app/file/restore", { id }).then(() => undefined);
  }

  /**
   * Create a folder row on the LIVE (release) stage.
   *
   * `stage: "release"` is sent explicitly — see the module header.
   * `/app/folder/create` is one of the four `parse_mutating_stage` routes
   * (`file/mod.rs:1059`), but it is NOT one of the four that emit
   * `warnings`, so there is nothing extra to surface here.
   */
  createFolder(path: string): Promise<FileEntry> {
    return this.http.post<FileEntry>("/app/folder/create", { path, stage: "release" });
  }
}
