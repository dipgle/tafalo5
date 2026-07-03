// FilesClient — `/app/file/*` + `/app/folder/*`.
//
// Uploads are multipart only (the server persists binaries straight from
// the multipart stream; never base64-in-JSON). Each part is a (`path`,
// `file`) pair and the request is repeatable for batch upload.

import type { HttpCore } from "./http.js";

export interface FileEntry {
  id?: string;
  path?: string;
  name?: string;
  size?: number;
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

export class FilesClient {
  constructor(private readonly http: HttpCore) {}

  /** Upload one or more files in a single multipart request. */
  async upload(parts: UploadPart | UploadPart[]): Promise<{ file: FileEntry[] }> {
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
    return this.http.postForm<{ file: FileEntry[] }>("/app/file/upload", form);
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

  rename(id: string, name: string): Promise<void> {
    return this.http.post("/app/file/rename", { id, name }).then(() => undefined);
  }

  /** Soft-delete (moves to trash). */
  del(id: string): Promise<void> {
    return this.http.post("/app/file/del", { id }).then(() => undefined);
  }

  restore(id: string): Promise<void> {
    return this.http.post("/app/file/restore", { id }).then(() => undefined);
  }

  createFolder(path: string): Promise<FileEntry> {
    return this.http.post<FileEntry>("/app/folder/create", { path });
  }
}
