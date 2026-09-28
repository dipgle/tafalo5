// BundleClient  — `/app/bundle/*`
// StagesClient  — `/app/release*` + `/app/test/*`
//
// http.post / http.postForm AUTO-INJECT `app_tid` from useApp() — do NOT
// include it in any request body or FormData constructed here.

import type { HttpCore } from "./http.js";

// ====================================================================
// Shared interfaces
// ====================================================================

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

export interface BundleUploadResult {
  tid: string;
  version: string;
  sha256: string;
  file_count: number;
  total_bytes: number;
  uploaded_at: number;
  original_filename?: string | null;
}

export interface BundleActivateResult {
  current_bundle_version: string | null;
  previous_bundle_version: string | null;
}

export interface BundleRollbackResult {
  current_bundle_version: string | null;
  previous_bundle_version: string | null;
}

export interface BundleUnpublishResult {
  current_bundle_version: null;
  previous_bundle_version: string | null;
}

/**
 * Returned by `BundleClient.list()`.
 *
 * Note: the server also emits `current_bundle_version` and
 * `previous_bundle_version` as top-level envelope siblings of `data`.
 * Those fields are not unwrapped by the SDK transport layer, but the same
 * information is available per-entry via `BundleVersion.is_current` and
 * `BundleVersion.is_previous`.
 */
export type BundleListResult = BundleVersion[];

// ====================================================================
// Stages interfaces
// ====================================================================

export interface ReleaseResult {
  /** false when there is nothing to promote (see `msg`). */
  result: boolean;
  msg?: string;
  /** A real promote is queued: poll `releaseStatus(job_id)`. */
  queued?: boolean;
  job_id?: string;
  status?: "queued";
  /** Dry run: the diff, nothing written. */
  dry_run?: boolean;
  [k: string]: unknown;
}

export interface ReleaseStatus {
  /** false when the job id is unknown or not a release job (see `msg`). */
  result: boolean;
  msg?: string;
  job_id?: string;
  status?: "pending" | "running" | "succeeded" | "failed" | "dead" | "cancelled";
  progress?: unknown;
  error?: string | null;
  attempts?: number;
}

export interface BundleDeleteResult {
  app_tid: string;
  version: string;
  files_removed: number;
  bytes_freed: number;
}

export interface ReleaseBackup {
  ts: number;
  has_manifest: boolean;
}

export interface ReleaseRollbackResult {
  /** false when a release is running or the backup does not exist (see `msg`). */
  result: boolean;
  msg?: string;
  /** Restoring a backup snapshot. */
  data?: {
    restored_from_ts?: number;
    restored_rows?: number;
    safety_backup_at?: string;
    /** Pointer swap (no `backupTs`): the versions after the swap. */
    current_release_version?: string | null;
    previous_release_version?: string | null;
  };
}

export interface TestStageStatus {
  used_storage: number;
  cap: number;
  last_activity_at: number;
  idle_for_ms: number;
  auto_delete_at: number | null;
  swept_at: number | null;
  ttl_ms: number;
}

export interface TestWipeResult {
  wiped_rows: number;
}

// ====================================================================
// BundleClient
// ====================================================================

/**
 * Manages versioned bundle uploads and activation for an app.
 *
 * All methods target the active app set by `useApp()` — `app_tid` is
 * injected automatically by `http`.
 */
export class BundleClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Upload a zip archive as a new immutable bundle version.
   *
   * Accepts either a pre-built `FormData` (fields: `version`, `notes?`,
   * `file`) **or** a plain object with the same fields plus the zip as a
   * `Blob`/`File`.  `app_tid` is injected; do not include it.
   *
   * The server validates `version` (alphanumeric + `.`, `_`, `-`, ≤ 64 chars)
   * and rejects re-uploads of the same version string.
   */
  upload(
    input:
      | FormData
      | { version: string; notes?: string; file: Blob | File },
  ): Promise<BundleUploadResult> {
    let form: FormData;
    if (input instanceof FormData) {
      form = input;
    } else {
      form = new FormData();
      form.append("version", input.version);
      if (input.notes != null) form.append("notes", input.notes);
      const filename =
        input.file instanceof File ? input.file.name : "bundle.zip";
      form.append("file", input.file, filename);
    }
    return this.http.postForm<BundleUploadResult>("/app/bundle/upload", form);
  }

  /**
   * Atomically flip `apps.current_bundle_version` to `version`.
   * The previous active version is stashed for one-click rollback.
   */
  activate(version: string): Promise<BundleActivateResult> {
    return this.http.post<BundleActivateResult>("/app/bundle/activate", {
      version,
    });
  }

  /**
   * Swap `current_bundle_version` ↔ `previous_bundle_version`.
   * Fails if there is no previous version recorded.
   */
  rollback(): Promise<BundleRollbackResult> {
    return this.http.post<BundleRollbackResult>("/app/bundle/rollback", {});
  }

  /**
   * Take the site offline by NULLing `current_bundle_version`.
   * The cleared version is stashed as `previous`, so `rollback()` or a
   * fresh `activate()` re-publishes it.
   */
  unpublish(): Promise<BundleUnpublishResult> {
    return this.http.post<BundleUnpublishResult>("/app/bundle/unpublish", {});
  }

  /**
   * List bundle versions for the app, newest first.
   *
   * The transport unwraps the `data` array; use `is_current` / `is_previous`
   * on each entry to identify the live and previous versions.
   *
   * @param limit Default 20, clamped server-side to 1–200.
   */
  list(limit?: number): Promise<BundleListResult> {
    return this.http.post<BundleListResult>(
      "/app/bundle/list",
      limit != null ? { limit } : {},
    );
  }

  /**
   * Delete a stored bundle version and its files (Manager). Refused with
   * `bundle_is_live` for the active version and `bundle_is_rollback_target`
   * for the previous one; `bundle_not_found` when it does not exist.
   */
  delete(version: string): Promise<BundleDeleteResult> {
    return this.http.post<BundleDeleteResult>("/app/bundle/delete", { version });
  }
}

// ====================================================================
// StagesClient
// ====================================================================

/**
 * Manages the test → release promotion pipeline and test-stage quota.
 *
 * All methods target the active app set by `useApp()` — `app_tid` is
 * injected automatically by `http`.
 */
export class StagesClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Promote test-stage files to release (Manager). The promote runs in the
   * background: the call returns `{ queued: true, job_id }` — poll
   * `releaseStatus(job_id)`. The current release is backed up first.
   * Resolves `result: false` (not an error) when the test stage is empty.
   *
   * @param dryRun When true, returns the diff without applying anything.
   */
  promote(dryRun = false): Promise<ReleaseResult> {
    return this.http.postFull<ReleaseResult>("/app/release", {
      dry_run: dryRun,
    });
  }

  /** Progress of a queued promote (Manager of the job's app). */
  releaseStatus(jobId: string): Promise<ReleaseStatus> {
    return this.http.postFull<ReleaseStatus>("/app/release/status", { job_id: jobId });
  }

  /**
   * List available release backup snapshots, sorted newest first.
   * Each entry carries `ts` (millisecond timestamp) and `has_manifest`.
   */
  listBackups(): Promise<ReleaseBackup[]> {
    return this.http.post<ReleaseBackup[]>("/app/release/list", {});
  }

  /**
   * Roll the release stage back (Manager). With `backupTs` (from
   * `listBackups()`) the release is restored from that snapshot, after a
   * safety backup of the current one. Without it, the previous release
   * becomes current again (an instant pointer swap). Resolves
   * `result: false` (not an error) when a release is running or the backup
   * does not exist.
   */
  rollbackRelease(backupTs?: number): Promise<ReleaseRollbackResult> {
    return this.http.postFull<ReleaseRollbackResult>("/app/release/rollback", {
      backup_ts: backupTs ?? 0,
    });
  }

  /**
   * Read test-stage quota and TTL metadata.
   * Readable by any app Reader.
   */
  testStatus(): Promise<TestStageStatus> {
    return this.http.post<TestStageStatus>("/app/test/status", {});
  }

  /**
   * Immediately destroy all test-stage files (rows + bytes).
   * Requires Manager permission.
   */
  testWipe(): Promise<TestWipeResult> {
    return this.http.post<TestWipeResult>("/app/test/wipe", {});
  }
}
