// SiteClient — `/app/site/*`. The content-addressed blob/snapshot engine
// behind the in-UI editor + no-code page builder (crates/routes/src/
// site.rs + snapshot.rs). One model backs both static files (`kind:"file"`)
// and no-code pages (`kind:"page"`, a JSON component tree).
//
// All eleven endpoints are Manager-gated (`site.rs` — every handler opens
// with `require_app_perm(… AppPermLevel::Manager)`) and app-scoped:
// `http.post` auto-injects `app_tid` from `useApp()`.
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
// blank — `snapshot::ensure_draft`, snapshot.rs:77). `list`/`get`/
// `fileHistory` show `COALESCE(draft, live)` — the open draft if one
// exists, else live (snapshot.rs:322 and :367) — so what you read back is
// the WORKING COPY, which can already differ from what visitors see.
// `publish()` is the only operation that flips what's actually served,
// atomically, and rejects an EMPTY draft so a publish can never wipe a live
// site (`snapshot::publish`, snapshot.rs:413; refusal "nothing to publish"
// at :429).
//
// ── Serve precedence — READ THIS BEFORE YOUR FIRST publish() ────────────
// `crates/routes/src/public.rs:640-654` (snapshot tier; bundle tier at
// :656-664, legacy release/`public/` tier at :680+): once an app has ANY
// live snapshot (i.e. `publish()` has been called at least once, ever),
// serve resolves EVERY request through `live_snapshot -> entry -> blob` and
// returns (a 404 if the path isn't in the snapshot) WITHOUT ever falling
// through to `current_bundle_version` (`BundleClient`) or the legacy
// `current_release_version` / `public/` tree below it — the snapshot branch
// `return`s unconditionally. There is no `unpublish`/clear route for
// snapshots (unlike `BundleClient.unpublish()`): the eleven routes are
// put / delete / list / get / publish / rollback / history / file-history /
// blob / backfill / preview, and `rollback()` only retargets
// `live_snapshot` to a DIFFERENT snapshot id, it never nulls it out. In
// practice: the first `publish()` on an app is a ONE-WAY switch off
// bundles/legacy files for that app.
//
// The same precedence is why release-stage writes through `FilesClient`
// stop reaching visitors once you publish here: those routes still answer
// `result:true` and carry a `file_write_shadowed_by_snapshot` warning
// instead. See `FileWriteWarning` in `files.ts`.

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
   *  site.rs:280-290). */
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

/**
 * Why `backfill()` did not create a snapshot. `null` when it did.
 *
 * `too_many_files` is a REFUSAL (nothing written), not a no-op — see
 * {@link SiteClient.backfill}.
 */
export type BackfillReason = "already_on_engine" | "no_files" | "too_many_files";

/** Full result of `backfill()` (site.rs:152-161). */
export interface BackfillResult {
  /** True iff a snapshot was created and made live (`snapshot_id !== null`). */
  imported: boolean;
  snapshot_id: string | null;
  /** Set only when `imported` is false. See {@link BackfillReason}. */
  reason: BackfillReason | null;
  /** How many files were actually copied into the snapshot. `0` on refusal. */
  file_count: number;
  /** The source tree exceeded the import cap and NOTHING was written. */
  truncated: boolean;
  /** Source keys that could not be read; they are NOT in the snapshot and
   *  are therefore no longer served. */
  skipped: string[];
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
   * transactionally so a crash never leaves them torn
   * (`snapshot::put_entry`, snapshot.rs:181).
   *
   * ── Size limits (two layers, and the one that matters is the DECODED one)
   * Per file: 52,428,800 B (50 MiB) measured on the DECODED bytes —
   * `site.rs` `SITE_PUT_MAX_FILE_BYTES` (:47), enforced by `check_put_size`
   * (:244) from the handler at :296. Both input shapes go through the same
   * gate, so a 60 MiB paste in `text` is refused exactly like a 60 MiB
   * `base64`. The refusal names the file and both numbers.
   *
   * Body layer: 74,099,372 B — `site.rs` `SITE_PUT_REQ_CAP` (:76), derived
   * as `(SITE_PUT_MAX_FILE_BYTES / 3 + 1) * 4 + 4 MiB` so base64's 4/3 plus
   * the JSON envelope still fits. It sits deliberately ABOVE the per-file
   * cap: a file a little over the cap must still REACH the handler, because
   * a request killed by the body layer comes back as axum's bare text 413
   * with no `code`, no file name and no number.
   *
   * This is NOT `FilesClient`'s cap. `SITE_PUT_MAX_FILE_BYTES` is
   * deliberately not aliased to `file::MAX_UPLOAD_BYTES` — site authoring
   * and file upload are two decisions with two constants, and they can
   * move independently.
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
   * Roll `live_snapshot` back to any prior PUBLISHED snapshot of this app —
   * an O(1) atomic pointer flip. The open draft (working tree) is left
   * untouched.
   *
   * Two refusals, both BadRequest (`check_rollback_target`,
   * snapshot.rs:511):
   *
   *  1. `snapshotId` doesn't belong to this app — answered identically
   *     whether or not it exists under some other app, so the refusal can
   *     never be used to confirm another tenant's snapshot ids.
   *  2. `snapshotId` IS this app's open DRAFT (snapshot.rs:528). Refused
   *     since 2026-08: making the draft live would put unreviewed content
   *     in front of visitors, and worse, it would FUSE the two pointers —
   *     from then on every save into the draft would change the live site
   *     the moment it was saved, because the live pointer and the working
   *     tree would be the same snapshot. The message names the way out:
   *     `POST /app/site/publish` to turn the draft into a version, or
   *     `POST /app/site/history` to pick a published one.
   *
   * Studio's own UI hides the control on the draft row, so a caller only
   * meets (2) through the API — which is exactly why the rule lives in the
   * endpoint and not in the client.
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
   * (`snapshot::read_app_blob`, snapshot.rs:1400, which checks
   * `snapshots.app_tid` before reading). Use this (not `get`) to view/diff a specific
   * historical version's content by the `blob_sha` from `fileHistory()`.
   */
  async blob(sha: string): Promise<BlobLookup> {
    const res = await this.http.post<BlobLookup>("/app/site/blob", { sha });
    return { found: res.found, content_base64: res.content_base64 };
  }

  /**
   * One-time import of an app's CURRENTLY-SERVED tree (active bundle, else
   * the legacy release/public tree) into a snapshot, making it live — lets
   * an app that predates the engine move onto it in one call
   * (`snapshot::backfill_app`, snapshot.rs:1210).
   *
   * ⚠ `imported: false` IS NOT ONE OUTCOME. Three different things produce
   * it and they need three different sentences on screen — read `reason`,
   * not just `imported`:
   *
   *  * `already_on_engine` (snapshot.rs:1221) — the app already has a live
   *    snapshot. Nothing to do; this is the idempotent no-op.
   *  * `no_files` (snapshot.rs:1291) — there was nothing to import. Check
   *    `skipped` before calling it empty: every source key may have been
   *    unreadable.
   *  * `too_many_files` (snapshot.rs:1245) — a REFUSAL, not a no-op. The
   *    source tree is larger than `TFL5_BACKFILL_MAX_FILES` (default 5000,
   *    `BACKFILL_MAX_FILES_DEFAULT` at snapshot.rs:1166) and **NOTHING was
   *    written**: `truncated` is true and `file_count` is 0. This exists
   *    because the listing used to be silently capped, so a 6000-file site
   *    migrated as a snapshot of 5000, went live missing a thousand files,
   *    and reported `imported:true`. Surface it as a failure the operator
   *    must act on (raise the env cap, or prune), never as "nothing to do".
   *
   * `skipped[]` names source keys that vanished or could not be read
   * between listing and copying. They are NOT in the snapshot and are
   * therefore NO LONGER SERVED once it goes live — a non-empty `skipped`
   * on an otherwise successful import means the site is now missing those
   * paths. The caller has to say so.
   *
   * `file_count` is how many files were actually copied (the server's own
   * `imported` counter); `imported` here is the boolean "was a snapshot
   * created", i.e. `snapshot_id !== null`.
   *
   * Wire note: like every other `/app/site/*` route, these are top-level
   * envelope siblings, not nested under `data`.
   */
  async backfill(): Promise<BackfillResult> {
    const res = await this.http.post<BackfillResult>("/app/site/backfill", {});
    return {
      imported: res.imported,
      snapshot_id: res.snapshot_id,
      reason: res.reason ?? null,
      file_count: res.file_count ?? 0,
      truncated: res.truncated ?? false,
      skipped: res.skipped ?? [],
    };
  }

  /**
   * Build the URL for the in-editor DRAFT preview (`GET /app/site/preview`,
   * site.rs:173) — the only site-engine route that ISN'T a JSON POST.
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
