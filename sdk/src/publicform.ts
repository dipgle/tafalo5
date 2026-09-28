// PublicFormClient — anonymous form submissions (contact forms, sign-ups)
// plus the admin side: form schemas and captured submissions.

import type { HttpCore } from "./http.js";

export interface PublicFormSubmitInput {
  /** Target app. Required even without `useApp()`: this call is anonymous. */
  app_tid: string;
  /** The form's id, as configured with `setConfig()`. */
  form_id: string;
  /** Field values, keyed by the schema's field names (at most 32). */
  fields: Record<string, string>;
}

export interface PublicFormSubmitResult {
  /** Submission tid (`sub-<uuid>`). */
  submission_tid: string;
}

/** One field of a form schema. */
export interface PublicFormFieldDecl {
  /** Default `"string"`. `"email"` requires one `@` and no whitespace. */
  type?: "string" | "email" | "number" | "bool";
  /** Default false. */
  required?: boolean;
  /** 1–65535 characters; default 4096. */
  max_len?: number;
}

/** A form schema. Unknown keys are refused (`public_form_schema_invalid`). */
export interface PublicFormSchema {
  fields: Record<string, PublicFormFieldDecl>;
  /** Submissions allowed per IP address per sliding hour. Default 5. */
  rate_per_ip_per_hour?: number;
  /** Lifetime cap for the form. Default 10 000. */
  max_total_submissions?: number;
  /** Default false — unknown keys in a submission are refused. */
  allow_unknown_fields?: boolean;
  /** Flat string attributes checked against readers' scope bindings. */
  scope_attrs?: Record<string, string>;
}

export interface PublicFormConfig {
  form_id: string;
  /** `false` for a form that was never configured (not an error). */
  configured: boolean;
  /** `null` exactly when `configured` is false. */
  schema: PublicFormSchema | null;
}

export interface PublicFormConfigMap {
  /** `form_id` → schema; `{}` when the app has no forms. */
  forms: Record<string, PublicFormSchema>;
  form_ids: string[];
}

export interface PublicFormSubmission {
  tid: string;
  form_id: string;
  client_ip: string;
  user_agent: string | null;
  /** Submitted values; masked for readers whose scope binding masks PII. */
  fields: Record<string, unknown>;
  created_at: number;
}

export interface PublicFormListResult {
  /** Newest first. */
  submissions: PublicFormSubmission[];
  /** Oldest `created_at` on this page (pass as `before_ts`); `null` only on an empty page. */
  next_before_ts: number | null;
}

export class PublicFormClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Submit a form entry — no sign-in needed. Refusals carry a `code`:
   * `public_form_not_configured`, `public_form_too_many_fields`,
   * `public_form_unknown_field`, `public_form_field_required`,
   * `public_form_field_too_long`, `public_form_field_invalid_email`,
   * `public_form_rate_limited`, `public_form_quota_full`. There is no bot
   * check on this route; the per-IP and total caps are the protection.
   */
  async submit(input: PublicFormSubmitInput): Promise<PublicFormSubmitResult> {
    const env = await this.http.postEnvelope<{ submission_tid: string }>("/app/public-form/submit", input);
    return { submission_tid: env.submission_tid };
  }

  /**
   * Create or replace a form's schema (Designer). It replaces the whole
   * entry — read it with `getConfig()` first to keep fields such as
   * `scope_attrs`. Pass `null` to remove the form.
   */
  setConfig(formId: string, schema: PublicFormSchema): Promise<{ form_id: string; schema: PublicFormSchema }>;
  setConfig(formId: string, schema: null): Promise<{ removed: true; form_id: string }>;
  setConfig(
    formId: string,
    schema: PublicFormSchema | null,
  ): Promise<{ form_id: string; schema: PublicFormSchema } | { removed: true; form_id: string }> {
    return this.http.post("/admin/public-form/set-config", { form_id: formId, schema });
  }

  /**
   * Read one form's schema, or every form's when `formId` is omitted
   * (Designer). A reader restricted by scope must name a form
   * (`scope_form_required`).
   */
  getConfig(): Promise<PublicFormConfigMap>;
  getConfig(formId: string): Promise<PublicFormConfig>;
  getConfig(formId?: string): Promise<PublicFormConfig | PublicFormConfigMap> {
    return this.http.post("/admin/public-form/get-config", formId !== undefined ? { form_id: formId } : {});
  }

  /**
   * Captured submissions, newest first (Manager — this is other people's
   * data). Page with `next_before_ts`. A scope-restricted reader must pin
   * `form_id`.
   */
  async list(input: { form_id?: string; limit?: number; before_ts?: number } = {}): Promise<PublicFormListResult> {
    const env = await this.http.postEnvelope<PublicFormListResult>("/admin/public-form/list", input);
    return { submissions: env.submissions, next_before_ts: env.next_before_ts };
  }
}
