// FilesClient — `/app/file/*` + `/app/folder/*`.
//
// Two ways to write bytes:
//   - `upload()` — multipart (binary-safe, the server streams it straight to
//     storage). Prefer this for anything a user picks from disk.
//   - `save()`   — base64-in-JSON, for runtimes that cannot build FormData.
//
// Stages. Every file row lives in one of two stages, `"test"` (draft) or
// `"release"` (live). The server's defaults differ by operation ON PURPOSE,
// so a forgotten field never overwrites the live site:
//   - writes (`upload`, `save`)                 → default `"test"`
//   - reads  (`list`, `get`, `signUrl`)         → default `"release"`
//   - mutations (`rename`, `del`, `createFolder`, `aclSet`) → default `"release"`
// This client always sends an explicit stage on mutations, and lets you pass
// one everywhere else. Pass `{ stage: "release" }` to write to the live tree.
//
// Paths are the file's full relative path inside the app (`"img/logo.png"`),
// not a folder. No leading slash is needed; `..`, empty and `.`-leading
// segments are rejected, and depth is capped at 16 segments.

import type { HttpCore } from "./http.js";

export type FileStage = "test" | "release";

/** A row from `/app/file/list`. */
export interface FileEntry {
  tid: string;
  path: string;
  is_dir: boolean;
  parent_tid: string | null;
  size: number;
  mime: string | null;
  managers: string[];
  editors: string[];
  readers: string[];
  deletable: string[];
  noaccess: string[];
  author: string;
  updated_at: number;
}

/** One row written by `upload()` / `save()`. */
export interface WrittenFile {
  tid: string;
  path: string;
  stage: FileStage;
  size: number;
  mime: string;
  parent_tid: string | null;
  /** Upload only: the filename the part was sent with. */
  original?: string;
}

/**
 * Returned beside a write when it lands in the release stage of an app whose
 * front-end is served by the site engine: the bytes were stored but visitors
 * will not see them (the live snapshot wins). Publish through `tfl5.site`
 * instead. Servers in strict mode refuse such writes with this same `code`.
 */
export interface FileWriteWarning {
  code: "file_write_shadowed_by_snapshot" | (string & {});
  /** Human-readable; branch on `code`. */
  msg: string;
  /** The live snapshot that is served instead. */
  live_snapshot?: string;
}

export interface UploadResult {
  /** The rows written, in request order. */
  files: WrittenFile[];
  /** Present only when a write is shadowed; see {@link FileWriteWarning}. */
  warnings?: FileWriteWarning[];
}

export interface FileRenameResult {
  tid: string;
  old_path: string;
  path: string;
  stage: FileStage;
  parent_tid: string | null;
  warnings?: FileWriteWarning[];
}

export interface FileDeleteResult {
  tid: string;
  /** Bytes returned to the app's storage allowance. */
  freed: number;
  is_dir: boolean;
  trashed_at: number;
  warnings?: FileWriteWarning[];
}

export interface UploadPart {
  /**
   * Destination path of the file inside the app, e.g. `"img/logo.png"`.
   * When omitted the part's filename is used.
   */
  path?: string;
  /** The binary. In the browser a File/Blob; in Node a Blob/Uint8Array. */
  file: Blob | Uint8Array;
  /** Filename sent with the part (defaults to the File's name or "file"). */
  filename?: string;
}

export interface UploadOptions {
  /** Target stage. Server default when omitted: `"test"`. */
  stage?: FileStage;
  /** Tenancy attributes stored on every written row (scope-filtered apps). */
  scopeAttrs?: Record<string, unknown>;
}

export interface SaveInput {
  path: string;
  /** File content, base64 (standard or URL-safe). Max 50 MiB decoded. */
  contentBase64: string;
  /** Defaults to a MIME derived from the extension. */
  mime?: string;
  /** Target stage. Server default when omitted: `"test"`. */
  stage?: FileStage;
  scopeAttrs?: Record<string, unknown>;
}

export interface FileContent {
  tid: string;
  path: string;
  stage: FileStage;
  size: number;
  mime: string;
  content_base64: string;
}

export interface FileAclInput {
  path: string;
  /** Defaults to `"release"`. */
  stage?: FileStage;
  /**
   * ACL arrays. Send raw ids (`"u-…"`, `"r-…"`, `"g-…"`); the server
   * normalises role tokens itself, so do not pre-wrap them in brackets.
   * Omitted arrays are stored empty.
   */
  managers?: string[];
  editors?: string[];
  readers?: string[];
  deletable?: string[];
  noaccess?: string[];
}

export interface FileAcl {
  path: string;
  managers: string[];
  editors: string[];
  readers: string[];
  deletable: string[];
  noaccess: string[];
}

export interface TrashEntry {
  tid: string;
  path: string;
  stage: FileStage;
  is_dir: boolean;
  size: number | null;
  mime: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
  author: string;
}

export class FilesClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload one or more files in a single multipart request (Editor).
   * Max 50 MiB per file and 100 MiB per request; allowed extensions:
   * html/css/js/json, images, fonts, text, sqlite/db/bin, wasm, zip/tar/gz.
   */
  async upload(parts: UploadPart | UploadPart[], opts: UploadOptions = {}): Promise<UploadResult> {
    const list = Array.isArray(parts) ? parts : [parts];
    const form = new FormData();
    if (opts.stage) form.append("stage", opts.stage);
    if (opts.scopeAttrs) form.append("scope_attrs", JSON.stringify(opts.scopeAttrs));
    for (const p of list) {
      // `path` must precede its `file` part: the server pairs each file with
      // the most recent path field.
      if (p.path) form.append("path", p.path);
      // `as BlobPart`: TS 5.7+ types `Uint8Array<ArrayBufferLike>` as
      // incompatible with `BlobPart` over the `SharedArrayBuffer` edge, but a
      // plain Uint8Array is a valid Blob part at runtime.
      const blob = p.file instanceof Blob ? p.file : new Blob([p.file as BlobPart]);
      const name =
        p.filename ?? (typeof File !== "undefined" && p.file instanceof File ? p.file.name : "file");
      form.append("file", blob, name);
    }
    const env = await this.http.postFormEnvelope<{ data: WrittenFile[]; warnings?: FileWriteWarning[] }>(
      "/app/file/upload",
      form,
    );
    return env.warnings ? { files: env.data, warnings: env.warnings } : { files: env.data };
  }

  /**
   * List the app's files in one stage (Reader; rows you cannot see are
   * filtered out). Pass `prefix` to keep only paths under it — filtering
   * is client-side, the server always returns the whole stage.
   */
  async list(opts: { stage?: FileStage; prefix?: string } = {}): Promise<FileEntry[]> {
    const rows = await this.http.post<FileEntry[]>(
      "/app/file/list",
      opts.stage ? { stage: opts.stage } : {},
    );
    const prefix = opts.prefix?.replace(/^\/+/, "");
    return prefix ? rows.filter((r) => r.path.startsWith(prefix)) : rows;
  }

  /** Write one file from base64 (Editor). Same limits as `upload()`. */
  async save(input: SaveInput): Promise<WrittenFile & { warnings?: FileWriteWarning[] }> {
    const env = await this.http.postEnvelope<{ data: WrittenFile; warnings?: FileWriteWarning[] }>("/app/file/save", {
      path: input.path,
      content_base64: input.contentBase64,
      ...(input.mime !== undefined ? { mime: input.mime } : {}),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.scopeAttrs !== undefined ? { scope_attrs: input.scopeAttrs } : {}),
    });
    return env.warnings ? { ...env.data, warnings: env.warnings } : env.data;
  }

  /**
   * Read one file's content as base64 (Reader + the row's own ACL).
   * Files over 10 MiB are refused with code `file_too_large` — use
   * `signUrl()` for those.
   */
  get(path: string, opts: { stage?: FileStage } = {}): Promise<FileContent> {
    return this.http.post<FileContent>("/app/file/get", {
      path,
      ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
    });
  }

  /**
   * Mint a short-lived signed URL for a file. Returns a relative
   * `signed_url` (`/_signed/<token>`) plus its expiry. Default TTL is
   * 5 minutes (server cap: 1 hour), so mint at view time rather than
   * persisting the URL. Aggregate-binding callers are rejected
   * (`pii_aggregate_only`).
   */
  signUrl(
    path: string,
    opts: { expires_in_sec?: number; stage?: FileStage } = {},
  ): Promise<{ signed_url: string; expires_at: number; cache_seconds: number }> {
    return this.http.post<{ signed_url: string; expires_at: number; cache_seconds: number }>(
      "/app/file/sign-url",
      { path, ...opts },
    );
  }

  /** Move/rename a file or folder (Editor). */
  async rename(path: string, newPath: string, opts: { stage?: FileStage } = {}): Promise<FileRenameResult> {
    const env = await this.http.postEnvelope<{ data: FileRenameResult; warnings?: FileWriteWarning[] }>(
      "/app/file/rename",
      { path, new_path: newPath, stage: opts.stage ?? "release" },
    );
    return env.warnings ? { ...env.data, warnings: env.warnings } : env.data;
  }

  /**
   * Soft-delete a file (moves it to the trash; see `trashList` / `restore`).
   * Folders need `recursive: true`.
   */
  async del(path: string, opts: { stage?: FileStage; recursive?: boolean } = {}): Promise<FileDeleteResult> {
    const env = await this.http.postEnvelope<{ data: FileDeleteResult; warnings?: FileWriteWarning[] }>(
      "/app/file/del",
      { path, stage: opts.stage ?? "release", ...(opts.recursive ? { recursive: true } : {}) },
    );
    return env.warnings ? { ...env.data, warnings: env.warnings } : env.data;
  }

  /** List trashed rows (Editor). Omit `stage` to list both stages. */
  trashList(stage?: FileStage): Promise<TrashEntry[]> {
    return this.http.post<TrashEntry[]>("/app/file/trash-list", stage ? { stage } : {});
  }

  /**
   * Restore a trashed row by its `tid` (from `trashList`). Pass `newPath`
   * when the original path has since been reused (files only).
   */
  restore(
    fileTid: string,
    opts: { newPath?: string } = {},
  ): Promise<{ tid: string; path: string; original_path: string; renamed: boolean; stage: FileStage; is_dir: boolean }> {
    return this.http.post("/app/file/restore", {
      file_tid: fileTid,
      ...(opts.newPath !== undefined ? { new_path: opts.newPath } : {}),
    });
  }

  /**
   * Permanently delete a trashed row and its bytes (Manager). Irreversible —
   * there is no confirmation step on the server.
   */
  purge(fileTid: string): Promise<{ tid: string; purged_size: number; is_dir: boolean }> {
    return this.http.post("/app/file/purge", { file_tid: fileTid });
  }

  /** Replace a file's row-level ACL (Manager). Returns the stored arrays. */
  aclSet(input: FileAclInput): Promise<FileAcl> {
    const { stage, ...rest } = input;
    return this.http.post<FileAcl>("/app/file/acl-set", { ...rest, stage: stage ?? "release" });
  }

  /** Create a folder (Editor). Defaults to the release stage. */
  createFolder(
    path: string,
    opts: { stage?: FileStage } = {},
  ): Promise<{ tid: string; path: string; stage: FileStage; parent_tid: string | null; is_dir: true }> {
    return this.http.post("/app/folder/create", { path, stage: opts.stage ?? "release" });
  }
}
