// BundleClient — `/app/bundle/*`. Versioned static-asset (FE) bundles.
// StagesClient — `/app/release*` + `/app/test/*`. The oldest publish tier:
//   the test(draft) → release promotion pipeline and test-stage quota.
// DomainClient — `/app/domain/*`. Custom domain binding, DNS verification,
//   and subdomain delegation.
//
// All three clients are app-scoped: `http.post` auto-injects `app_tid` from
// `useApp()` unless a call already carries one, so no method below takes an
// explicit `appTid` parameter (the two exceptions — `reclaimSub`'s
// `adminAppTid` and the request-flow's own `app_tid` semantics — use a
// DIFFERENT field name than `app_tid` and so are spelled out explicitly).
//
// Source of truth read for this file: crates/routes/src/bundle.rs,
// crates/routes/src/domain.rs, crates/routes/src/domain_delegation.rs,
// crates/routes/src/file/release.rs, crates/routes/src/file/trash.rs.
// Line citations were re-measured against the platform tree on 2026-09-03
// (branch fix/promote-byte-labels, f7cf481+f493fdc).

import type { HttpCore } from "./http.js";

// ====================================================================
// BundleClient — versioned FE bundles
// ====================================================================

/** One uploaded bundle version, as returned by `list()`. */
export interface BundleVersion {
  tid: string;
  version: string;
  sha256: string;
  file_count: number;
  total_bytes: number;
  uploaded_by: string;
  uploaded_at: number;
  notes?: string | null;
  is_current: boolean;
  is_previous: boolean;
}

/** Response from `upload()` (bundle.rs:273-286). */
export interface BundleUploadResult {
  tid: string;
  app_tid: string;
  version: string;
  sha256: string;
  file_count: number;
  total_bytes: number;
  uploaded_at: number;
  original_filename?: string | null;
}

/** Response from `activate()` (bundle.rs:426-434). */
export interface BundleActivateResult {
  app_tid: string;
  current_bundle_version: string | null;
  previous_bundle_version: string | null;
}

/** Response from `rollback()` (bundle.rs:487-495). */
export interface BundleRollbackResult {
  app_tid: string;
  current_bundle_version: string | null;
  previous_bundle_version: string | null;
}

/** Response from `unpublish()` (bundle.rs:552-559). */
export interface BundleUnpublishResult {
  app_tid: string;
  current_bundle_version: null;
  previous_bundle_version: string | null;
}

/** Response from `del()` (bundle.rs:767-775). */
export interface BundleDeleteResult {
  app_tid: string;
  version: string;
  /** How many stored objects were removed. */
  files_removed: number;
  /** The version's `total_bytes`, now reclaimed. */
  bytes_freed: number;
}

/**
 * Returned by `list()`.
 *
 * The server also emits `current_bundle_version` / `previous_bundle_version`
 * as top-level envelope siblings of `data` (bundle.rs:627-633). The
 * transport only unwraps `data`, so those two siblings are NOT visible here
 * — read `.is_current` / `.is_previous` per entry instead.
 */
export type BundleListResult = BundleVersion[];

/**
 * Manages versioned bundle uploads and activation for the scoped app.
 *
 * A bundle is the static FE asset tree (html/js/css/images) for a release.
 * Bytes are quota-free (don't count against `apps.used_storage`) and entries
 * are ACL-free (gated only by "is this the app's current bundle?").
 *
 * NOTE — bundles are one of several serve tiers. `crates/routes/src/
 * public.rs` resolves, in order: content-addressed `live_snapshot` (see
 * `SiteClient`/`snapshot.rs`) FIRST at :640-654, then
 * `current_bundle_version` (this client) at :656-664, then the legacy
 * `current_release_version` / `public/` tree at :680+. The snapshot branch
 * `return`s unconditionally, so a file you activate here is silently
 * shadowed the moment the app has ever been published onto a site-engine
 * snapshot — `activate()` will still answer `result:true`.
 */
export class BundleClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload a zip archive as a new immutable bundle version.
   *
   * Multipart fields: `app_tid` (auto-injected), `version`, `notes?`,
   * `file` (the zip). Field order does not matter — the handler matches by
   * field name (bundle.rs:96-149).
   *
   * ── Server caps — FOUR numbers, all verified 2026-09-03 ────────────────
   * Constants are the anchors; grep the symbol, not the line.
   *
   *  * the zip itself ≤ 52,428,800 B (50 MiB) — checked at bundle.rs:171
   *    against `file::MAX_UPLOAD_BYTES` (`file/mod.rs:84`). Refusal code
   *    `file_too_large`. (This was 10 MiB until 2026-08-26; any doc still
   *    saying "10 MB" predates that.)
   *  * ≤ 500 entries — `file::MAX_BUNDLE_ENTRIES` (`file/mod.rs:89`),
   *    checked at bundle.rs:348.
   *  * ≤ 104,857,600 B (100 MiB) total UNCOMPRESSED —
   *    `file::MAX_BUNDLE_UNCOMPRESSED_BYTES` (`file/mod.rs:113`, defined as
   *    `2 * MAX_UPLOAD_BYTES`), running total checked at bundle.rs:386.
   *    This is the zip-bomb guard: the per-entry check cannot fire until
   *    the entry is reached, so without a running total a small archive can
   *    still promise gigabytes. It is 2× rather than 1× on purpose — equal
   *    numbers would mean one max-size asset could not travel beside even
   *    one more byte.
   *  * each individual entry ≤ 52,428,800 B (50 MiB) uncompressed —
   *    bundle.rs:375, same constant as the zip. Nothing sneaks past the
   *    single-file rule by hiding in an archive.
   *
   * Above the handler sits a body layer of 54,525,952 B (52 MiB) —
   * `BUNDLE_REQ_CAP` (bundle.rs:85) = `MAX_UPLOAD_BYTES + 2 MiB`. A zip
   * BETWEEN 50 and 52 MiB is refused by the handler, by size, naming both
   * numbers; a zip ABOVE 52 MiB is cut off mid-stream by the layer and the
   * answer is `upload_request_too_large` (via
   * `file::multipart_read_error`, `file/mod.rs:372-380`) — deliberately
   * NOT a parse error. That mapping exists because `MultipartError`
   * displays as "Error parsing multipart/form-data request" for every cause
   * it has, and in 2026-08 that sentence had people rebuilding zips that
   * were never broken.
   *
   * `version` must be alphanumeric + `. _ -`, ≤ 64 chars, and unique per
   * app — re-uploading an existing version throws with
   * `.code === "bundle_version_exists"`. Requires Manager.
   */
  upload(
    input: FormData | { version: string; notes?: string; file: Blob | File },
  ): Promise<BundleUploadResult> {
    let form: FormData;
    if (input instanceof FormData) {
      form = input;
    } else {
      form = new FormData();
      form.append("version", input.version);
      if (input.notes != null) form.append("notes", input.notes);
      const filename = input.file instanceof File ? input.file.name : "bundle.zip";
      form.append("file", input.file, filename);
    }
    return this.http.postForm<BundleUploadResult>("/app/bundle/upload", form);
  }

  /**
   * Atomically flip `apps.current_bundle_version` to `version`.
   * The previous active version is stashed for one-click `rollback()`.
   * Throws with `.code === "bundle_version_not_found"` if `version` was
   * never uploaded for this app. Requires Manager.
   */
  activate(version: string): Promise<BundleActivateResult> {
    return this.http.post<BundleActivateResult>("/app/bundle/activate", { version });
  }

  /**
   * Swap `current_bundle_version` ↔ `previous_bundle_version`.
   * Throws with `.code === "bundle_no_previous"` if there is nothing to
   * roll back to. Requires Manager.
   */
  rollback(): Promise<BundleRollbackResult> {
    return this.http.post<BundleRollbackResult>("/app/bundle/rollback", {});
  }

  /**
   * Take the site offline by NULLing `current_bundle_version` (stashed as
   * `previous`, so `rollback()` or a fresh `activate()` republishes it).
   * Idempotent — double-unpublish keeps the earlier `previous`
   * (bundle.rs:524-526). Requires Manager.
   */
  unpublish(): Promise<BundleUnpublishResult> {
    return this.http.post<BundleUnpublishResult>("/app/bundle/unpublish", {});
  }

  /**
   * Permanently delete one uploaded bundle version — its rows AND its
   * bytes (`POST /app/bundle/delete`, bundle.rs:96 → `delete_version` at
   * :632). Requires Manager (gate at bundle.rs:638). This is the only
   * method on this client that destroys data; the rest only move pointers.
   *
   * Storage is freed first, the row second: if the object delete fails
   * halfway the row is still there, the version still serves, and a retry
   * is a no-op on the objects already gone. The other order would leave
   * bytes nobody can name. It also writes an audit row (`bundle.delete`)
   * for the same reason.
   *
   * Three refusals, all BadRequest with a stable `code` — the server
   * refuses rather than letting you shoot the live site:
   *
   *  * `bundle_is_live` (bundle.rs:662) — `version` is
   *    `apps.current_bundle_version`. Activate another version (or
   *    `unpublish()`) first.
   *  * `bundle_is_rollback_target` (bundle.rs:672) — `version` is
   *    `apps.previous_bundle_version`, i.e. where `rollback()` would land.
   *    Activate a different version first so rollback has somewhere to go.
   *  * `bundle_not_found` (bundle.rs:686) — no such version on this app.
   *
   * A fourth, `app_not_found` (bundle.rs:647), fires when `app_tid` itself
   * doesn't resolve.
   *
   * NOTE — named `delete` after the route. Sibling clients spell their
   * destructive method `del` (`FilesClient.del`, `SiteClient.del`,
   * `DomainClient.del`); this one does not, so don't reach for `del()` here.
   */
  delete(version: string): Promise<BundleDeleteResult> {
    return this.http.post<BundleDeleteResult>("/app/bundle/delete", { version });
  }

  /**
   * List bundle versions for the app, newest first. Requires Reader.
   * @param limit Default 20, clamped server-side to 1-200.
   */
  list(limit?: number): Promise<BundleListResult> {
    return this.http.post<BundleListResult>("/app/bundle/list", limit != null ? { limit } : {});
  }
}

// ====================================================================
// StagesClient — test(draft) → release promotion + test-stage quota
// ====================================================================

/**
 * Result of `promote()` — an ENQUEUE receipt, not a promotion report
 * (`file/release.rs:1242-1246`).
 *
 * The route used to promote inline and answer with row counts. It does not
 * any more; see {@link StagesClient.promote}.
 */
export interface ReleaseQueued {
  /** Always `true` on this branch — the job is on the queue, not done. */
  queued: true;
  /** Poll this with {@link StagesClient.releaseStatus}. */
  job_id: string;
  status: "queued";
}

/** Result of `promote(true)` — the synchronous dry-run diff. */
export interface ReleaseDryRun {
  /** How many rows are staged in test. */
  test_rows: number;
  /** How many release rows that promotion would replace. */
  release_rows_to_replace: number;
}

/** Coarse job state from `releaseStatus()`. Mirrors `job_queue.status`. */
export type ReleaseJobStatus = "pending" | "running" | "succeeded" | "failed" | string;

/** Result of `releaseStatus()` (`file/release.rs:1329-1336`). */
export interface ReleaseStatus {
  job_id: string;
  status: ReleaseJobStatus;
  /** Fine-grained progress blob written by the worker. Shape is job-defined
   *  and may be `null` before the first progress report. */
  progress: unknown;
  /** The job's `last_error`, when it has one. NOT an SDK-level failure — a
   *  failed job still answers `result:true` here. */
  error: string | null;
  /** Queue retry count. */
  attempts: number;
}

/** One rollback-able release backup, as returned by `listBackups()`. */
export interface ReleaseBackup {
  /** Epoch-ms folder name under `_release_backup/`. Pass as `backupTs`. */
  ts: number;
  /** False when `_rows.json` is absent — the bytes are there but the row
   *  metadata is not, so a restore cannot reproduce ACLs. */
  has_manifest: boolean;
}

/** `rollbackRelease()` on the versioned (pointer-swap) path. */
export interface ReleaseRollbackVersioned {
  current_release_version: string | null;
  previous_release_version: string | null;
}

/** `rollbackRelease(ts)` on the legacy `_release_backup` restore path. */
export interface ReleaseRollbackLegacy {
  restored_from_ts: number;
  restored_rows: number;
  /** Absolute server path of the safety backup taken before restoring. */
  safety_backup_at: string;
}

export interface TestStageStatus {
  used_storage: number;
  cap: number;
  last_activity_at: number;
  /** `now - last_activity_at`, or 0 when the stage has never been touched. */
  idle_for_ms: number;
  /** `last_activity_at + ttl_ms`, or null when the TTL is disabled. */
  auto_delete_at: number | null;
  swept_at: number | null;
  ttl_ms: number;
}

export interface TestWipeResult {
  wiped_rows: number;
}

/**
 * StagesClient — the test(draft) → release promotion pipeline
 * (`/app/release`, `/app/release/status`, `/app/release/list`,
 * `/app/release/rollback`) and test-stage quota (`/app/test/status`,
 * `/app/test/wipe`). Handlers live in `crates/routes/src/file/release.rs`
 * and `crates/routes/src/file/trash.rs`.
 *
 * This is the OLDEST of the three publish tiers. Read the serve-precedence
 * note on {@link BundleClient}: a snapshot published through `SiteClient`
 * shadows the bundle tier, which shadows this one. A successful `promote()`
 * on an app that has a live snapshot changes nothing a visitor sees.
 *
 * ── Soft rejections THROW here ─────────────────────────────────────────
 * Several of these routes answer HTTP 200 `{result:false, msg, code?}`.
 * `HttpCore.unwrap` treats any non-`result:true` envelope as an error, so
 * they arrive as a thrown `Tfl5Error` — you cannot inspect `.result` on a
 * returned value, and a `try`/`catch` branching on `.code` is the only way
 * to tell "refused" from "broken". Each method lists its codes.
 */
export class StagesClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Promote test-stage files to release. Requires Manager
   * (`file/release.rs:1107`).
   *
   * ⚠ **ASYNCHRONOUS.** This does NOT promote before it answers. Promotion
   * holds a per-app advisory lock and does multi-second disk I/O; doing
   * that inline once took a production cell down, so the work is queued and
   * the call returns `{queued:true, job_id, status:"queued"}`
   * (`release.rs:1242-1246`). **The promotion is not finished when this
   * resolves** — poll {@link releaseStatus} with `job_id` until the status
   * is terminal. Any code that treats a resolved `promote()` as "published"
   * is reporting success for work that may still fail in the worker.
   *
   * De-duplicated, not idempotent: if a release job for this app is already
   * `pending` or `running` you get THAT job's `job_id` back rather than a
   * second job. A later re-publish after the first finishes is a valid new
   * job and does get its own id.
   *
   * Refusals (all thrown):
   *  * empty test stage — no `code`, only a `msg` (`release.rs:1198-1203`).
   *    Nothing was queued.
   *  * `.code === "draft_disk_missing"` (`release.rs:1185`) — the draft's
   *    rows exist but its bytes are not on disk. Refused BEFORE enqueuing,
   *    because promoting would wipe the live site. Re-upload the draft.
   *
   * @param dryRun Answers SYNCHRONOUSLY with the diff and queues nothing —
   *   the one call on this method that does not mutate. Returns
   *   {@link ReleaseDryRun}.
   */
  async promote(dryRun: false): Promise<ReleaseQueued>;
  async promote(dryRun: true): Promise<ReleaseDryRun>;
  async promote(dryRun?: boolean): Promise<ReleaseQueued | ReleaseDryRun>;
  async promote(dryRun = false): Promise<ReleaseQueued | ReleaseDryRun> {
    // postFull, not post: the queued branch puts `job_id` / `status` at the
    // top level with no `data` key, while the dry-run branch nests its diff
    // under `data`. Only the whole envelope covers both.
    const env = await this.http.postFull<{
      dry_run?: boolean;
      data?: ReleaseDryRun;
      queued?: true;
      job_id?: string;
      status?: "queued";
    }>("/app/release", { dry_run: dryRun });
    if (env.dry_run === true) return env.data as ReleaseDryRun;
    return { queued: true, job_id: env.job_id as string, status: "queued" };
  }

  /**
   * Poll a queued promotion. Requires Manager — checked against the
   * **job's own** app, read from the job payload rather than from a
   * caller-supplied id, so one tenant cannot watch another's publish
   * (`file/release.rs:1327`).
   *
   * A finished-but-FAILED job is still a successful call: `status` carries
   * the verdict and `error` the reason. Read `status`, don't assume this
   * resolving means the promotion worked.
   *
   * Refusals (thrown, no `code` — match on nothing, treat as fatal):
   * unknown `job_id` (`release.rs:1307`), or a `job_id` that belongs to a
   * different job kind (`release.rs:1315`).
   */
  releaseStatus(jobId: string): Promise<ReleaseStatus> {
    return this.http.post<ReleaseStatus>("/app/release/status", { job_id: jobId });
  }

  /**
   * List available release backup snapshots, newest first. Requires
   * Manager (`file/release.rs:1489`).
   *
   * Each successful promotion captures the OUTGOING release rows into
   * `_release_backup/<ts>/_rows.json` beside the renamed `public/` tree.
   * On object-storage-backed apps the listing walks backend keys with a
   * 4096-key ceiling (`release.rs:1530-1533`), so a tenant with very many
   * backups should prune rather than trust this to be complete.
   */
  listBackups(): Promise<ReleaseBackup[]> {
    return this.http.post<ReleaseBackup[]>("/app/release/list", {});
  }

  /**
   * Roll the release stage back. Requires Manager
   * (`file/release.rs:1594`). Takes the same per-app advisory lock as
   * `promote()` so the two can never interleave.
   *
   * TWO DIFFERENT OPERATIONS behind one route, chosen by `backupTs`:
   *
   *  * **omitted / 0 — versioned pointer swap** (the modern path, taken
   *    when the app serves through `apps.current_release_version`). O(1):
   *    swaps `current_release_version` ↔ `previous_release_version`, moves
   *    no files. Resolves to {@link ReleaseRollbackVersioned}. Refuses with
   *    `.code === "no_previous_release"` (`release.rs:1639`) when there is
   *    nothing to swap to.
   *  * **an explicit `ts` from {@link listBackups} — legacy restore.** Reads
   *    that backup's manifest, snapshots the CURRENT release into a fresh
   *    `_release_backup/<now>/` first (so the rollback is itself
   *    reversible), then swaps the trees. Resolves to
   *    {@link ReleaseRollbackLegacy}.
   *
   * Passing a `ts` on an app that has a release pointer forces the legacy
   * path — the two are not interchangeable, so don't pass `0` expecting
   * "the newest backup".
   *
   * Also refuses (thrown, no `code`) when the advisory lock is busy because
   * a promotion is in flight (`release.rs:1610`) — that one is retryable.
   */
  rollbackRelease(): Promise<ReleaseRollbackVersioned>;
  rollbackRelease(backupTs: number): Promise<ReleaseRollbackLegacy>;
  rollbackRelease(
    backupTs?: number,
  ): Promise<ReleaseRollbackVersioned | ReleaseRollbackLegacy> {
    return this.http.post<ReleaseRollbackVersioned | ReleaseRollbackLegacy>(
      "/app/release/rollback",
      backupTs != null ? { backup_ts: backupTs } : {},
    );
  }

  /**
   * Read test-stage quota + idle/TTL metadata. Requires only Reader
   * (`file/release.rs:1919`) — anyone who can see the app may see its
   * quota. `auto_delete_at` is null when the idle TTL is disabled
   * (`ttl_ms <= 0`) or the stage has never been written.
   */
  testStatus(): Promise<TestStageStatus> {
    return this.http.post<TestStageStatus>("/app/test/status", {});
  }

  /**
   * Immediately destroy every test-stage file row AND its bytes. Requires
   * Manager (`file/trash.rs:485`). Destructive and not undoable — this does
   * not route through trash. The release stage is untouched.
   */
  testWipe(): Promise<TestWipeResult> {
    return this.http.post<TestWipeResult>("/app/test/wipe", {});
  }
}

// ====================================================================
// DomainClient — custom domains + delegation
// ====================================================================

/** A custom domain row returned by `list()`. */
export interface DomainRecord {
  tid: string;
  domain: string;
  active: boolean;
  /** Derived: `!active` -> "needs_recheck"; `active` + served once ->
   *  "live"; `active` + never served -> "warming" (domain.rs:1108-1118). */
  badge: "live" | "warming" | "needs_recheck";
  verified_at: number | null;
  first_served_at: number | null;
  last_recheck: number | null;
  consecutive_failures: number;
  created_at: number;
  /** DNS instructions, present only for inactive rows. */
  verify?: DnsInstructions;
}

export interface DnsRecord {
  type: "A" | "TXT";
  host: string;
  value: string;
  note: string;
}

export interface DnsInstructions {
  verify_token: string;
  records: DnsRecord[];
  note: string;
}

/**
 * Response from `preview()`.
 *
 * `preview()`/`add()` reply with HTTP 200 + `{result:false, msg, code?}` for
 * expected "soft" rejections (invalid host, domain owned by another app,
 * delegation deny) rather than a 4xx — the transport still throws (see
 * `HttpCore.unwrap`'s `env.result === false` branch), surfacing as a
 * `Tfl5Error` whose `.code` is one of `"private_needs_request"` /
 * `"label_denied"` / `"quota_reached"` (delegation gate,
 * `evaluate_delegation` at domain_delegation.rs:469, `quota_reached` at
 * :566) or absent (generic validation) — inspect it to decide whether to
 * offer a "Request access" action.
 *
 * ── TWO different quota refusals. They are not interchangeable ──────────
 * Both `preview()` and `add()` can refuse for lack of room, with different
 * codes AND different HTTP statuses:
 *
 *  * **`domain_quota_reached` — HTTP 402 Payment Required.** The APP has
 *    spent its licensed domain slots (`enforce_domain_quota`,
 *    domain.rs:437; raised at domain.rs:672-674 for `preview` and
 *    :1008-1010 for `add`). A hard status ON PURPOSE, breaking the
 *    platform's usual 200-`{result:false}` habit: answering 200 here is
 *    what let an automated publish read "fine" and carry on to a DNS
 *    change that could never work. Remedy is a larger plan or releasing a
 *    domain — and note the refusal points at "the app's owner", because
 *    `del()` is Owner-only while `add()` is not, so a Manager who hits the
 *    cap cannot clear it themselves.
 *  * **`quota_reached` — HTTP 200 `{result:false}`** (thrown by the
 *    transport as a `Tfl5Error` all the same). The DELEGATION grant's
 *    `max_subs` under one parent domain is exhausted
 *    (domain_delegation.rs:566). Nothing to buy: the parent's owner has to
 *    raise `max_subs`, and `requestAccess()` is NOT the way out — the
 *    request flow rejects this outcome (see {@link DomainClient.requestAccess}).
 *
 * Branch on `code`, and treat 402 as "billing", not as "ask the parent".
 */
export interface DomainPreviewResult {
  domain: string;
  app_tid?: string;
  /** True when DNS can be skipped (local-dev / subdomain shortcut / delegation). */
  auto_active?: boolean;
  /** Local-dev (`*.localhost`) branch ONLY: always `""` — no real token is
   *  minted since DNS is skipped entirely (domain.rs:473-482). */
  verify_token?: string;
  /** Present when `auto_active` is true via the subdomain-owner shortcut. */
  shortcut?: { parent_app_tid: string; parent_domain: string };
  /** Present when `auto_active` is true via a delegation grant. */
  delegation?: { parent_app_tid: string; parent_domain: string; delegation_tid: string | null };
  /** DNS instructions to show the user when verification is required. */
  verify?: DnsInstructions;
  already_owned?: boolean;
  note?: string;
}

/** Response from `add()` (domain.rs:727-945). Always carries `app_tid`. */
export interface DomainAddResult {
  tid: string;
  domain: string;
  app_tid: string;
  active: boolean;
  method?: "a" | "subdomain-shortcut" | "subdomain-delegated";
  already?: boolean;
  parent?: { app_tid: string; domain: string };
  delegation_tid?: string | null;
  /** Always `[]` today — kept for wire-shape back-compat (domain.rs:933). */
  warnings?: string[];
}

/**
 * Response from `verify()` (domain.rs:1257-1385). Unlike `DomainAddResult`,
 * this NEVER carries `app_tid` (the handler's JSON simply omits it on every
 * branch) and `method` can additionally be `"txt"` for a legacy TXT-token
 * recheck.
 */
export interface DomainVerifyResult {
  tid: string;
  domain: string;
  active: boolean;
  method?: "txt" | "a" | "subdomain-shortcut";
  already?: boolean;
}

// ---- Delegation — parent-owner configuration ----

export interface DelegationConfig {
  domain: string;
  /** `"private"` (default) or `"public"`. */
  mode: "private" | "public";
  label_rules: { allow: string[]; deny: string[] };
  whitelist_count: number;
  /** Constant fail-safe ruleset auto-applied on first-time public mode. */
  public_default_rules: { allow: string[]; deny: string[] };
}

export interface WhitelistEntry {
  tid: string;
  grantee_user_tid: string;
  granted_by: string;
  conditions: Record<string, unknown>;
  max_subs: number | null;
  expires_at: number | null;
  created_at: number;
}

/** Entry returned by `delegationsReceived()` — what the caller can bind under. */
export interface ReceivedDelegation {
  parent_domain: string;
  via: "whitelist" | "public";
  /** Only present for `via: "whitelist"` rows. */
  expires_at?: number | null;
  label_rules: { allow: string[]; deny: string[] };
}

/** A sub domain currently bound under a parent. Returned by `subsOfParent()`. */
export interface SubDomainEntry {
  tid: string;
  domain: string;
  app_tid: string;
  app_name: string;
  app_owner: string;
  active: boolean;
  created_at: number;
}

export interface TestPatternResult {
  verdict: "allow" | "deny" | "no-allow-match";
  matched_pattern: string | null;
  reason: string;
}

// ---- Delegation — access-request flow ----

export interface DomainBindRequest {
  tid: string;
  parent_domain: string;
  requested_host: string;
  app_tid: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  note: string | null;
  created_at: number;
  decided_at: number | null;
  delegation_tid: string | null;
}

/** Incoming request visible to the parent owner via `requestsReceived()`. */
export interface ReceivedBindRequest {
  tid: string;
  requested_host: string;
  requester_user_tid: string;
  requester_username: string | null;
  app_tid: string;
  note: string | null;
  created_at: number;
}

/**
 * DomainClient — wraps all `/app/domain/*` endpoints (21 total: 5 core +
 * 16 delegation, split across `domain.rs` and `domain_delegation.rs`).
 *
 * ── Perm levels — re-split on 2026-08-17, verified 2026-09-03 ──────────
 * Batch 45 put `preview`/`add`/`del`/`verify` all on **Owner**. That was
 * superseded: an app Admin was shown the whole Add-domain card (because
 * `list` had to be loosened to Designer for the tab to render at all) and
 * then told "Access denied". The rule is now split by what the action
 * DOES, not by which file it lives in — see the `## 2026-08-17` section of
 * `crates/routes/src/domain.rs`'s module docstring:
 *
 *  * **Manager** — `preview()` (domain.rs:574), `add()` (:915),
 *    `verify()` (:1536) and `requestAccess()`
 *    (`/app/domain/request`, domain_delegation.rs:1752). Binding a
 *    hostname to an app you already administer grants no privilege you
 *    lacked: a Manager can already publish that app's content.
 *  * **Owner** — `del()` (domain.rs:1470). Unbinding takes a live site
 *    off the air, and is deliberately NOT symmetric with binding.
 *  * **Owner** — every parent-owner endpoint: `setMode`, `setLabelRules`,
 *    `getConfig`, `testPattern`, `whitelistAdd`/`Remove`/`List`,
 *    `subsOfParent`, `requestsReceived`, `approveRequest`, `denyRequest`
 *    (all via `require_parent_owner`, domain_delegation.rs:662, gate at
 *    :668) and `reclaimSub` (domain_delegation.rs:1288). These hand YOUR
 *    domain to somebody else's app — giving an asset away, not using one.
 *  * **Designer** — `list()` only (domain.rs:1385).
 *  * **No app perm** — `delegationsReceived()` / `myRequests()` /
 *    `cancelRequest()`, scoped to the logged-in caller's own session (and
 *    requiring the caller's email to be verified).
 */
export class DomainClient {
  constructor(private readonly http: HttpCore) {}

  // ------------------------------------------------------------------
  // Core domain operations
  // ------------------------------------------------------------------

  /**
   * Mint DNS instructions for a domain — no DB write. Requires **Manager**
   * (domain.rs:574; was Owner before 2026-08-17).
   * Returns `auto_active: true` when DNS verification can be skipped
   * (local-dev host / subdomain shortcut / delegation grant) — see
   * `DomainPreviewResult` for the soft-rejection / error-code contract,
   * including the two different quota refusals.
   */
  preview(domain: string): Promise<DomainPreviewResult> {
    return this.http.post<DomainPreviewResult>("/app/domain/preview", { domain });
  }

  /**
   * Verify domain ownership and bind it to the app. Requires **Manager**
   * (domain.rs:915; was Owner before 2026-08-17).
   * For public hosts, the domain's A record must already point at this
   * server (there is no TXT/token dance on `/add`).
   * Local-dev, subdomain-shortcut, and delegation hosts skip verification.
   * On the "A record not found" rejection, the thrown error's
   * `.body.data` carries `{domain, expected_a_target}`.
   * Can also refuse with HTTP 402 `domain_quota_reached` — see
   * `DomainPreviewResult`.
   */
  add(domain: string): Promise<DomainAddResult> {
    return this.http.post<DomainAddResult>("/app/domain/add", { domain });
  }

  /** List all custom domains bound to the app. Requires Designer. */
  list(): Promise<DomainRecord[]> {
    return this.http.post<DomainRecord[]>("/app/domain/list", {});
  }

  /** Remove a domain binding by its `tid`. Requires **Owner**
   *  (domain.rs:1470) — the ONE core domain op that stayed Owner when
   *  `preview`/`add`/`verify` moved to Manager on 2026-08-17, because
   *  unbinding takes a live site off the air. A Manager who has hit the
   *  domain-slot cap therefore cannot free a slot themselves. Throws
   *  NotFound if `tid` doesn't belong to this app (never silently
   *  no-ops). */
  del(tid: string): Promise<void> {
    return this.http.post("/app/domain/del", { tid }).then(() => undefined);
  }

  /**
   * Re-check DNS and re-activate an inactive domain row. Requires
   * **Manager** (domain.rs:1536; was Owner before 2026-08-17).
   * Tries a freshly-derived HMAC token first, then the row's legacy stored
   * token (for rows created under the old pending-token flow), accepting
   * either TXT or A proof. See `DomainVerifyResult` for the response shape
   * (notably: no `app_tid`, and `method` can be `"txt"`).
   */
  verify(tid: string): Promise<DomainVerifyResult> {
    return this.http.post<DomainVerifyResult>("/app/domain/verify", { tid });
  }

  // ------------------------------------------------------------------
  // Delegation — parent-owner configuration
  // ------------------------------------------------------------------

  /**
   * Toggle the delegation mode for a parent domain the caller owns.
   * `mode` must be `"private"` (default, explicit whitelist required) or
   * `"public"` (any authenticated + email-verified user may bind subs;
   * label rules still apply). First flip to public auto-populates
   * fail-safe default label rules UNLESS the owner already has rules set.
   * Requires Owner of the app that owns `domain`.
   */
  setMode(
    domain: string,
    mode: "private" | "public",
  ): Promise<{ domain: string; mode: string; auto_populated_default_rules: boolean }> {
    return this.http.post("/app/domain/mode", { domain, mode });
  }

  /**
   * Replace the `allow` / `deny` regex label-rule sets for a parent domain.
   * Patterns target the sub-prefix (everything before `.<parent>`). Max 10
   * patterns per list, max 200 chars each — an invalid pattern throws with
   * `.code === "invalid_regex"`. Pass empty arrays to clear. Requires Owner.
   */
  setLabelRules(
    domain: string,
    rules: { allow: string[]; deny: string[] },
  ): Promise<{ domain: string; allow_count: number; deny_count: number }> {
    return this.http.post("/app/domain/label-rules", {
      domain,
      allow: rules.allow,
      deny: rules.deny,
    });
  }

  /**
   * Read the current delegation config (mode + label rules + whitelist
   * count + the constant public-mode default rules) for a parent domain.
   * Requires Owner.
   */
  getConfig(domain: string): Promise<DelegationConfig> {
    return this.http.post<DelegationConfig>("/app/domain/get-config", { domain });
  }

  /**
   * Dry-run a candidate `allow`/`deny` ruleset against a single label
   * without persisting anything or touching the compiled-rules cache.
   * `label` must be a single DNS label (no dots). Requires Owner.
   */
  testPattern(
    domain: string,
    label: string,
    rules: { allow: string[]; deny: string[] },
  ): Promise<TestPatternResult> {
    return this.http.post<TestPatternResult>("/app/domain/delegation/test-pattern", {
      domain,
      label,
      allow: rules.allow,
      deny: rules.deny,
    });
  }

  // ------------------------------------------------------------------
  // Delegation — whitelist management (parent owner)
  // ------------------------------------------------------------------

  /**
   * Grant `granteeUserTid` the right to bind subdomains under `domain`.
   * Re-granting rotates `expires_at` + `max_subs` atomically (upsert on
   * `(parent_domain, grantee_user_tid)`). Pass `max_subs: null` (or omit)
   * to lift/leave unlimited; `max_subs` must be >= 1 if given. Rejects
   * granting the parent owner themselves. Requires Owner.
   */
  whitelistAdd(
    domain: string,
    granteeUserTid: string,
    opts: { expires_at?: number | null; max_subs?: number | null } = {},
  ): Promise<{
    tid: string;
    parent_domain: string;
    grantee_user_tid: string;
    expires_at: number | null;
    max_subs: number | null;
  }> {
    return this.http.post("/app/domain/whitelist/add", {
      domain,
      grantee_user_tid: granteeUserTid,
      ...opts,
    });
  }

  /**
   * Revoke a delegation grant for `granteeUserTid` under `domain`.
   * Existing subdomains the grantee already bound are NOT removed.
   * Requires Owner.
   */
  whitelistRemove(
    domain: string,
    granteeUserTid: string,
  ): Promise<{ parent_domain: string; removed_tid: string | null; existing_subs_kept: boolean }> {
    return this.http.post("/app/domain/whitelist/remove", {
      domain,
      grantee_user_tid: granteeUserTid,
    });
  }

  /** List all whitelist (delegation) grants for a parent domain. Requires Owner. */
  whitelistList(domain: string): Promise<WhitelistEntry[]> {
    return this.http.post<WhitelistEntry[]>("/app/domain/whitelist/list", { domain });
  }

  // ------------------------------------------------------------------
  // Delegation — grantee-side view
  // ------------------------------------------------------------------

  /**
   * List every parent domain the *caller* (from session, not `app_tid`) may
   * bind subdomains under — both explicit whitelist grants and public-mode
   * parents. No app scope needed. Requires the caller's email to be
   * verified; throws Unauthorized otherwise.
   */
  delegationsReceived(): Promise<ReceivedDelegation[]> {
    return this.http.post<ReceivedDelegation[]>("/app/domain/delegations/received", {});
  }

  // ------------------------------------------------------------------
  // Delegation — parent admin utilities
  // ------------------------------------------------------------------

  /**
   * Force-unbind a subdomain from whatever app currently holds it.
   * `adminAppTid` is the CALLER'S OWN app — used only to resolve their
   * identity/perm, NOT auto-injected as `app_tid` (this endpoint has no
   * `app_tid` field at all). The real authorization check is that the
   * caller owns the app bound to the STRICT longest-suffix parent of
   * `subDomain` (the sub itself is excluded from the parent search).
   */
  reclaimSub(
    adminAppTid: string,
    subDomain: string,
    reason?: string,
  ): Promise<{ sub_domain: string; parent_domain: string; reclaimed_from_app_tid: string }> {
    return this.http.post("/app/domain/reclaim-sub", {
      admin_app_tid: adminAppTid,
      sub_domain: subDomain,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * List every active subdomain currently bound under `domain` (the parent
   * row itself is excluded). Shows the app name + owner so the owner knows
   * what `reclaimSub()` would take. Requires Owner.
   */
  subsOfParent(domain: string): Promise<SubDomainEntry[]> {
    return this.http.post<SubDomainEntry[]>("/app/domain/subs-of-parent", { domain });
  }

  // ------------------------------------------------------------------
  // Delegation — access-request flow
  // ------------------------------------------------------------------

  /**
   * File a request to bind `domain` (a sub of a PRIVATE parent the caller
   * has no whitelist grant for). Only valid when the delegation gate would
   * otherwise deny with `.code === "private_needs_request"` — any other
   * outcome (already allowed / not a private parent / label-denied /
   * quota-reached) throws BadRequest instead. Idempotent: re-submitting a
   * still-pending request returns the existing row with
   * `already_pending: true`.
   *
   * Requires **Manager** of `app_tid` (the app the sub will be bound to) +
   * a verified email — `/app/domain/request` moved with `preview`/`add`/
   * `verify` on 2026-08-17 (gate at domain_delegation.rs:1752). It is the
   * grantee side of the flow: asking to bind a sub is using your own app,
   * not giving a domain away. The APPROVAL side (`approveRequest` /
   * `denyRequest`) is still Owner of the parent.
   */
  requestAccess(
    domain: string,
    note?: string,
  ): Promise<{
    tid: string;
    parent_domain: string;
    requested_host: string;
    status: "pending";
    already_pending: boolean;
  }> {
    return this.http.post("/app/domain/request", {
      domain,
      ...(note !== undefined ? { note } : {}),
    });
  }

  /**
   * Cancel a pending access request the caller filed. `requestTid` is the
   * `tid` from `requestAccess()`. Session-scoped (no app perm needed) —
   * only the original requester may cancel their own row.
   */
  cancelRequest(requestTid: string): Promise<void> {
    return this.http.post("/app/domain/request/cancel", { request_tid: requestTid }).then(() => undefined);
  }

  /** List all access requests the *caller* has filed (own view, session-scoped). */
  myRequests(): Promise<DomainBindRequest[]> {
    return this.http.post<DomainBindRequest[]>("/app/domain/requests/mine", {});
  }

  /**
   * List pending access requests received for `domain` (parent-owner view).
   * Requires Owner.
   */
  requestsReceived(domain: string): Promise<ReceivedBindRequest[]> {
    return this.http.post<ReceivedBindRequest[]>("/app/domain/requests/received", { domain });
  }

  /**
   * Approve a pending access request — mints (or rotates) the same kind of
   * `domain_delegations` grant `whitelistAdd()` would, then marks the
   * request `approved`. `max_subs` must be >= 1 if given. Requires Owner.
   */
  approveRequest(
    domain: string,
    requestTid: string,
    opts: { max_subs?: number; expires_at?: number } = {},
  ): Promise<{ request_tid: string; delegation_tid: string; grantee_user_tid: string }> {
    return this.http.post("/app/domain/request/approve", {
      domain,
      request_tid: requestTid,
      ...opts,
    });
  }

  /** Deny a pending access request. Requires Owner. */
  denyRequest(domain: string, requestTid: string): Promise<void> {
    return this.http
      .post("/app/domain/request/deny", { domain, request_tid: requestTid })
      .then(() => undefined);
  }
}
