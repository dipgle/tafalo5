// PublicFormClient — `/app/public-form/submit` (anonymous) plus the three
// Designer/Manager admin routes: `/admin/public-form/set-config`,
// `/admin/public-form/get-config` and `/admin/public-form/list`.
//
// Lets an app accept submissions from people who are NOT signed in — a
// contact form, a waitlist, a registration, an NPS survey. Without it, a
// landing page on tfl5 has to fall back to a `mailto:` link.
//
// Source of truth: `crates/routes/src/public_form.rs`, read 2026-09-03
// against branch fix/promote-byte-labels (f7cf481 + f493fdc).
//
// ── A form does not exist until a Designer configures it ────────────────
// The schema lives at `apps.acls.public_forms.<form_id>` — there is no
// `public_forms` table. Until `setConfig()` has run for a `form_id`,
// `submit()` refuses with `public_form_not_configured`
// (public_form.rs:195). So the order of operations is always
// setConfig → submit, never the reverse.
//
// ── Permission split, and why get-config is NOT Manager ────────────────
//   * `submit`     — anonymous, no cookie or token (public_form.rs:161).
//   * `setConfig`  — **Designer** (public_form.rs:607).
//   * `getConfig`  — **Designer** (public_form.rs:711). Deliberately the
//     WRITE gate, not `list`'s: whoever may overwrite this object must be
//     able to read it first. Manager and Owner sit above Designer in
//     `AppPermLevel`, so they are included.
//   * `list`       — **Manager** (public_form.rs:420), because it returns
//     submissions, i.e. other people's data.
//
// `get-config` was added 2026-08-22 to close a real hole: `set-config`
// REPLACES the whole entry, and until then nothing on the wire could read
// it back (`/app/get` does not select `acls`; `/app/scope/get` reads only
// `acls->'scope'`). Every edit was therefore made blind, from memory —
// which is how a form's `scope_attrs` gets silently dropped by someone who
// only meant to change a field label. Call `getConfig()` before
// `setConfig()` and merge; do not hand-rebuild the object.
//
// ── Wire-shape gotcha ──────────────────────────────────────────────────
// `submit` and `list` do NOT nest their payload under `data` — the fields
// are top-level siblings of `result` (`public_form.rs:392-395` and
// `:579-583`). `HttpCore.post()` unwraps `data` and, finding none, falls
// back to returning the WHOLE envelope. Both methods below pull the fields
// they need out of that envelope, so the declared return types are the
// useful payload rather than the raw wire shape. `set-config` and
// `get-config` DO use `data` and need no such handling.

import type { HttpCore } from "./http.js";

// ====================================================================
// Anonymous submit
// ====================================================================

export interface PublicFormSubmitInput {
  /**
   * Target app. NOT optional and NOT relying on `useApp()`: this endpoint
   * is anonymous and is normally called from a page that never logged in,
   * so there is no scoped app to inject. (`HttpCore` would inject one if a
   * session happened to have called `useApp()`, which is exactly the kind
   * of accidental coupling this explicit field avoids.)
   */
  app_tid: string;
  /** Form identifier, as configured under `apps.acls.public_forms`. */
  form_id: string;
  /**
   * Field values. Keys must match the schema's declared fields unless the
   * schema sets `allow_unknown_fields: true`. Values are strings; the
   * server coerces non-string JSON to string.
   */
  fields: Record<string, string>;
}

export interface PublicFormSubmitResult {
  /** Submission tid (`sub-<uuid>`). */
  submission_tid: string;
}

// ====================================================================
// Schema (the object `setConfig` writes and `getConfig` reads back)
// ====================================================================

/** One declared field in a form schema. */
export interface PublicFormFieldDecl {
  /**
   * `"string"` or `"email"`. `email` enforces a single `@`-containing
   * token with no whitespace — deliberately not RFC-strict, since the
   * verify-email loop is the real ground truth. An UNKNOWN `type` falls
   * back to `"string"` semantics rather than rejecting every submission,
   * so a typo here fails quietly open, not closed.
   */
  type?: "string" | "email" | string;
  /** Default false. */
  required?: boolean;
  /** Default 4096 characters (`DEFAULT_FIELD_MAX_LEN`). */
  max_len?: number;
  [k: string]: unknown;
}

/**
 * A form schema, stored verbatim at `apps.acls.public_forms.<form_id>`.
 *
 * `getConfig()` returns it unchanged so it can be round-tripped straight
 * back into `setConfig()`.
 */
export interface PublicFormSchema {
  fields: Record<string, PublicFormFieldDecl>;
  /** Per-IP sliding-hour cap. Default 5. */
  rate_per_ip_per_hour?: number;
  /** Lifetime cap per `(app, form)`. Default 10 000. */
  max_total_submissions?: number;
  /** Default false — unknown keys in a submission are rejected. */
  allow_unknown_fields?: boolean;
  /**
   * Row-level scope tags (REQ-TFL5-006 Batch D), a FLAT object of strings.
   * Checked at admin READ time, never at submit time — anonymous writes
   * have no caller binding to check. Nested values are rejected with
   * `public_form_scope_attrs_invalid`, because they would otherwise
   * silently match no binding at all.
   */
  scope_attrs?: Record<string, string>;
  [k: string]: unknown;
}

/** `setConfig()` result when a schema was written. */
export interface PublicFormSetConfigResult {
  form_id: string;
  schema: PublicFormSchema;
}

/** `setConfig(formId, null)` result — the form was turned off. */
export interface PublicFormRemoveResult {
  removed: true;
  form_id: string;
}

/** `getConfig(formId)` result — one form (public_form.rs:747-752). */
export interface PublicFormConfig {
  form_id: string;
  /**
   * False when the app exists but this form was never configured. That is
   * a legitimate answer — it is what a brand-new form looks like — and is
   * deliberately NOT an error, so an editor can open for the first form on
   * an app. A MISSING APP is the different case and throws NotFound.
   */
  configured: boolean;
  /** `null` exactly when `configured` is false. */
  schema: PublicFormSchema | null;
}

/** `getConfig()` result with no `form_id` — every form on the app. */
export interface PublicFormConfigMap {
  /** `form_id` → schema. `{}` (an empty map, never `null`) when the app
   *  has no forms, so a list screen can render "no forms yet" without
   *  inventing an empty object of its own. */
  forms: Record<string, PublicFormSchema>;
  /** The keys of `forms`, as the server enumerated them. */
  form_ids: string[];
}

// ====================================================================
// Admin listing
// ====================================================================

export interface PublicFormListInput {
  /** Pin one form. REQUIRED for scope-restricted callers — see
   *  {@link PublicFormClient.list}. */
  form_id?: string;
  limit?: number;
  /** Reverse-chronological cursor: rows with `created_at` strictly less
   *  than this. Pass the previous response's `next_before_ts`. */
  before_ts?: number;
}

export interface PublicFormSubmission {
  tid: string;
  form_id: string;
  /** Captured at submit time, through the trusted-proxy chain. */
  client_ip: string;
  user_agent: string | null;
  /**
   * The submitted values. MAY BE MASKED: a caller whose scope binding
   * resolves to `Masked` gets the app's declared `pii_fields` redacted
   * here (`public_form.rs:534-541`). What you see is not necessarily what
   * was submitted — don't write it back anywhere as if it were.
   */
  fields: Record<string, unknown>;
  created_at: number;
}

export interface PublicFormListResult {
  /** Newest first. */
  submissions: PublicFormSubmission[];
  /** Cursor for the next (older) page, or `null` on the last page. */
  next_before_ts: number | null;
}

// ====================================================================
// Client
// ====================================================================

/**
 * PublicFormClient — anonymous form submission plus the admin control
 * plane for form schemas and captured submissions.
 *
 * The admin routes are app-scoped in the usual way (`http.post`
 * auto-injects `app_tid` from `useApp()`); `submit()` is the exception and
 * takes `app_tid` explicitly because it is unauthenticated.
 */
export class PublicFormClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Submit a public form entry. **Anonymous** — no session cookie or bearer
   * token required (`public_form.rs:161`).
   *
   * Validation runs in this order, and every failure throws a `Tfl5Error`
   * with a stable `.code`:
   *  1. the form must be configured — `public_form_not_configured` (:195);
   *  2. hard cap of 32 fields per submission —
   *     `public_form_too_many_fields` (:208, `HARD_FIELD_COUNT_CAP`);
   *  3. unknown keys — `public_form_unknown_field` (:229), unless the
   *     schema sets `allow_unknown_fields: true`;
   *  4. per declared field: `public_form_field_required` (:263),
   *     `public_form_field_too_long` (:274, default 4096 chars),
   *     `public_form_field_invalid_email` (:280).
   *
   * Anti-abuse, both DB-side so they survive a process restart:
   *  * a per-IP sliding-hour cap (`rate_per_ip_per_hour`, default 5) →
   *    `public_form_rate_limited` (:344);
   *  * a lifetime cap per `(app, form)` (`max_total_submissions`, default
   *    10 000) → `public_form_quota_full` (:369).
   * The platform's general per-IP perimeter limit applies ON TOP of these.
   *
   * ⚠ There is **no CAPTCHA / Turnstile check** on this route. The caps
   * above are the whole defence; if you need proof-of-human, put it in
   * front of this call yourself.
   *
   * Wire note: `submission_tid` arrives as a top-level envelope sibling,
   * not under `data`.
   */
  async submit(input: PublicFormSubmitInput): Promise<PublicFormSubmitResult> {
    const env = await this.http.post<{ submission_tid: string }>(
      "/app/public-form/submit",
      input,
    );
    return { submission_tid: env.submission_tid };
  }

  /**
   * Write (create or replace) a form's schema. Requires **Designer**
   * (`public_form.rs:607`).
   *
   * ⚠ This REPLACES the whole entry at
   * `apps.acls.public_forms[form_id]` — it does not merge. Read the
   * current object with {@link getConfig} first and edit that, or you will
   * drop whatever you did not restate (`scope_attrs` is the field this
   * most often costs).
   *
   * The schema is fully validated at write time, not at submit time, so a
   * bad schema is your error rather than a stream of confusing 4xx for
   * end-users: a non-object throws `public_form_schema_invalid`
   * (:637), as do unknown top-level keys, negative/absurd caps and
   * malformed field declarations (`validate_schema`, :825 — including a
   * `fields` count over the same 32 cap `submit` enforces, :913). A
   * `scope_attrs` that is not a flat object of strings throws
   * `public_form_scope_attrs_invalid` (:859).
   *
   * @param schema Pass `null` to REMOVE the form (the route uses
   *   `acls #- ARRAY[...]`, since Postgres `jsonb_set` cannot delete a
   *   key). Removal resolves to {@link PublicFormRemoveResult} and is
   *   silent about whether the form existed.
   */
  setConfig(formId: string, schema: PublicFormSchema): Promise<PublicFormSetConfigResult>;
  setConfig(formId: string, schema: null): Promise<PublicFormRemoveResult>;
  setConfig(
    formId: string,
    schema: PublicFormSchema | null,
  ): Promise<PublicFormSetConfigResult | PublicFormRemoveResult> {
    return this.http.post<PublicFormSetConfigResult | PublicFormRemoveResult>(
      "/admin/public-form/set-config",
      { form_id: formId, schema },
    );
  }

  /**
   * Read back what {@link setConfig} wrote. Requires **Designer**
   * (`public_form.rs:711`) — the write gate, not `list()`'s Manager.
   *
   * Schemas are configuration, not submissions: no PII, no per-row data.
   * The response is the stored object verbatim, so it round-trips.
   *
   * @param formId Omit to read EVERY configured form on the app — resolves
   *   to {@link PublicFormConfigMap} (`{forms, form_ids}`, with `forms`
   *   being `{}` when there are none). Pass a `formId` to read one, which
   *   resolves to {@link PublicFormConfig} and reports an unconfigured
   *   form as `configured: false` rather than as an error.
   *
   * Throws:
   *  * NotFound — the APP row does not exist. Distinct from an
   *    unconfigured form, which is a successful `configured:false`.
   *  * `.code === "scope_form_required"` — a scope-restricted caller
   *    omitted `formId`. Cross-form reads are only for callers whose
   *    binding evaluates as global; a scoped caller must name one form.
   */
  getConfig(): Promise<PublicFormConfigMap>;
  getConfig(formId: string): Promise<PublicFormConfig>;
  getConfig(formId?: string): Promise<PublicFormConfig | PublicFormConfigMap> {
    return this.http.post<PublicFormConfig | PublicFormConfigMap>(
      "/admin/public-form/get-config",
      formId !== undefined ? { form_id: formId } : {},
    );
  }

  /**
   * Browse captured submissions, newest first. Requires **Manager**
   * (`public_form.rs:420`) — a higher bar than the schema routes, because
   * this returns other people's data.
   *
   * Paginate by passing the previous response's `next_before_ts` as
   * `before_ts`.
   *
   * Scope (REQ-TFL5-006 Batch D) is enforced here, not at submit time:
   *  * with `form_id` pinned, that form's `scope_attrs` is checked against
   *    the caller's binding — an out-of-scope Manager gets 403;
   *  * with `form_id` omitted (a cross-form browse), only a caller whose
   *    binding evaluates as global is allowed; a scoped Manager gets
   *    `.code === "scope_form_required"`;
   *  * a `Masked` binding redacts the app's declared `pii_fields` inside
   *    each row's `fields` (:542). Reads are recorded to the PII audit
   *    trail.
   *
   * The `scope_form_required` refusal is raised at :457 for this route
   * (`getConfig`'s twin is at :768).
   *
   * Wire note: `submissions` / `next_before_ts` arrive as top-level
   * envelope siblings, not under `data`.
   */
  async list(input: PublicFormListInput = {}): Promise<PublicFormListResult> {
    const env = await this.http.post<{
      submissions?: PublicFormSubmission[];
      next_before_ts?: number | null;
    }>("/admin/public-form/list", input);
    return {
      submissions: env.submissions ?? [],
      next_before_ts: env.next_before_ts ?? null,
    };
  }
}
