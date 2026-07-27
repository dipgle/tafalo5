// SiteClient — `/app/site/*`. The content-addressed blob/snapshot engine
// behind the in-UI editor + no-code page builder (crates/routes/src/
// site.rs + snapshot.rs). One model backs both static files (`kind:"file"`)
// and no-code pages (`kind:"page"`, a JSON component tree).
//
// All ten endpoints are Manager-gated and app-scoped: `http.post`
// auto-injects `app_tid` from `useApp()`.
//
// ── Wire-shape gotcha ────────────────────────────────────────────────────
// Unlike most tfl5 routes, NONE of `/app/site/*`'s JSON handlers nest their
// payload under a `data` key — every field is a top-level sibling of
// `result` (e.g. `put` replies `{result:true, snapshot_id, blob_sha, size,
// deduped}`, not `{result:true, data:{...}}`). `HttpCore.post()`'s unwrap
// only pulls out `data`, so with no `data` key it falls back to returning
// the WHOLE envelope object. Every method below accounts for this by
// pulling the fields it needs out of that raw envelope internally, so the
// return types you see are the useful payload — not the raw wire shape.
//
// ── Draft vs. live ───────────────────────────────────────────────────────
// `put`/`delete` write to the app's DRAFT snapshot (auto-created on first
// write, seeded from whatever is currently live so the editor never starts
// blank — snapshot.rs:76-157). `list`/`get`/`fileHistory` show
// `COALESCE(draft, live)` — the open draft if one exists, else live
// (snapshot.rs:296-310) — so what you read back is the WORKING COPY, which
// can already differ from what visitors see. `publish()` is the only
// operation that flips what's actually served, atomically, and rejects an
// EMPTY draft so a publish can never wipe a live site (snapshot.rs:408-412).
//
// ── Serve precedence — READ THIS BEFORE YOUR FIRST publish() ────────────
// `crates/routes/src/public.rs:294-331`: once an app has ANY live snapshot
// (i.e. `publish()` has been called at least once, ever), serve resolves
// EVERY request through `live_snapshot -> entry -> blob` and returns
// (a 404 if the path isn't in the snapshot) WITHOUT ever falling through to
// `current_bundle_version` (`BundleClient`) or the legacy `current_release_
// version` / `public/` tree below it. There is no `unpublish`/clear route
// for snapshots (unlike `BundleClient.unpublish()`) — `rollback()` only
// retargets `live_snapshot` to a DIFFERENT snapshot id, it never nulls it
// out. In practice: the first `publish()` on an app is a ONE-WAY switch off
// bundles/legacy files for that app.

import type { HttpCore } from "./http.js";

/** `"dir"` is a declared constant (`snapshot::KIND_DIR`) not currently
 *  produced by any writer — included for forward-compat only. */
export type SiteEntryKind = "file" | "page" | "dir";

/** One entry in the draft (or live, if no draft is open) working tree. */
export interface SiteEntry {
  path: string;
  entry_kind: SiteEntryKind;
  blob_sha: string | null;
  size: number;
  mime: string | null;
}

export interface PutEntryInput {
  path: string;
  /** `"file"` (default) or `"page"` (a JSON no-code component tree). */
  kind?: "file" | "page";
  /** UTF-8 text content. Exactly one of `text` / `base64` is required. */
  text?: string;
  /** Base64-encoded bytes — required for binary files. If both `text` and
   *  `base64` are given, `base64` wins (mirrors the server's match order,
   *  site.rs:185-195). */
  base64?: string;
  mime?: string;
}

export interface PutEntryResult {
  snapshot_id: string;
  blob_sha: string;
  size: number;
  /** True if identical bytes already existed in the blob store — dedup
   *  hit, no physical write. */
  deduped: boolean;
}

/** Shared shape for `get()` and `blob()` — a possibly-missing byte lookup. */
export interface BlobLookup {
  found: boolean;
  /** Present only when `found` is true. */
  content_base64?: string;
}

/** One snapshot in an app's history, as returned by `history()`. */
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

/** One historical version of a path, as returned by `fileHistory()`. */
export interface FileVersion {
  snapshot_id: string;
  note: string | null;
  created_at: number;
  blob_sha: string;
}

export class SiteClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Write (create or overwrite) a file/page entry in the app's draft.
   * Content-addressed + deduped; blob refcounts are maintained
   * transactionally so a crash never leaves them torn (snapshot.rs:162-252).
   * The request body itself is capped at 20 MB (~14 MB of base64 content) —
   * site.rs:39.
   */
  put(input: PutEntryInput): Promise<PutEntryResult> {
    if (input.base64 == null && input.text == null) {
      throw new Error("@tfl5/sdk: site.put() requires `text` or `base64`");
    }
    return this.http.post<PutEntryResult>("/app/site/put", {
      path: input.path,
      kind: input.kind,
      content_text: input.text,
      content_base64: input.base64,
      mime: input.mime,
    });
  }

  /** Remove an entry from the draft. `removed` is false if nothing was at `path`. */
  async del(path: string): Promise<{ removed: boolean }> {
    const res = await this.http.post<{ removed: boolean }>("/app/site/delete", { path });
    return { removed: res.removed };
  }

  /** List the current working tree (draft if open, else live) — metadata only. */
  async list(): Promise<SiteEntry[]> {
    const res = await this.http.post<{ entries: SiteEntry[] }>("/app/site/list", {});
    return res.entries;
  }

  /** Fetch one entry's bytes from the working tree (draft if open, else live). */
  async get(path: string): Promise<BlobLookup> {
    const res = await this.http.post<BlobLookup>("/app/site/get", { path });
    return { found: res.found, content_base64: res.content_base64 };
  }

  /**
   * Publish the draft: it BECOMES the new immutable live snapshot in one
   * atomic pointer flip, then a fresh draft is opened seeded from it for
   * continued editing. Throws BadRequest ("nothing to publish") if the
   * draft is empty — refusing to ever silently wipe a live site
   * (snapshot.rs:408-412). See the module-level "Serve precedence" note:
   * this is a one-way switch off bundles/legacy files for the app.
   * Returns the id of the newly-live snapshot.
   */
  async publish(note?: string): Promise<string> {
    const res = await this.http.post<{ live_snapshot: string }>("/app/site/publish", { note });
    return res.live_snapshot;
  }

  /**
   * Roll `live_snapshot` back to any prior snapshot of this app — an O(1)
   * atomic pointer flip. The open draft (working tree) is left untouched.
   * Throws BadRequest if `snapshotId` doesn't belong to this app.
   */
  async rollback(snapshotId: string): Promise<void> {
    await this.http.post("/app/site/rollback", { snapshot_id: snapshotId });
  }

  /** The app's full snapshot history, newest first — for a history/rollback UI. */
  async history(): Promise<SiteSnapshot[]> {
    const res = await this.http.post<{ snapshots: SiteSnapshot[] }>("/app/site/history", {});
    return res.snapshots;
  }

  /** Every snapshot that has held `path`, newest first — per-file version history. */
  async fileHistory(path: string): Promise<FileVersion[]> {
    const res = await this.http.post<{ versions: FileVersion[] }>("/app/site/file-history", {
      path,
    });
    return res.versions;
  }

  /**
   * Read a blob by its sha, scoped to this app — a sha from another
   * tenant's app resolves as `found: false` rather than leaking bytes
   * (snapshot.rs:850-867). Use this (not `get`) to view/diff a specific
   * historical version's content by the `blob_sha` from `fileHistory()`.
   */
  async blob(sha: string): Promise<BlobLookup> {
    const res = await this.http.post<BlobLookup>("/app/site/blob", { sha });
    return { found: res.found, content_base64: res.content_base64 };
  }

  /**
   * One-time import of an app's CURRENTLY-SERVED tree (active bundle, else
   * the legacy release/public tree) into a snapshot, making it live — lets
   * an app that predates the engine move onto it in one call. Idempotent:
   * `imported: false` (with `snapshot_id: null`) if the app already has a
   * live snapshot or there was nothing to import (snapshot.rs:703-714).
   */
  async backfill(): Promise<{ imported: boolean; snapshot_id: string | null }> {
    const res = await this.http.post<{ imported: boolean; snapshot_id: string | null }>(
      "/app/site/backfill",
      {},
    );
    return { imported: res.imported, snapshot_id: res.snapshot_id };
  }

  /**
   * Build the URL for the in-editor DRAFT preview (`GET /app/site/preview`,
   * site.rs:119-155) — the only site-engine route that ISN'T a JSON POST.
   * It renders the draft (not live) so authoring is unaffected by what
   * visitors see, and is meant to be navigated to directly (an `<iframe
   * src>` or a new tab), not `fetch()`-ed: the SDK transport has no plain
   * `GET` and can't attach cookie auth to a detached fetch anyway. Requires
   * a scoped app (`useApp()`); throws if none is set. 404s if the app has
   * no open draft yet (call `put()` at least once first).
   */
  previewUrl(path?: string): string {
    if (!this.http.appId) {
      throw new Error("@tfl5/sdk: site.previewUrl() requires a scoped app — call tfl5.useApp(appTid) first.");
    }
    const params = new URLSearchParams({ app_tid: this.http.appId });
    if (path) params.set("path", path);
    return `${this.http.host}/app/site/preview?${params.toString()}`;
  }
}
