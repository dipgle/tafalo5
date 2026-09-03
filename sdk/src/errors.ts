// Typed error hierarchy keyed on the server's stable `code` field.
//
// Classifiers MUST match on `code`, never on `msg` — the server reserves
// the right to reword / localize `msg` (VI⇄EN) without notice, but `code`
// is part of the fixed contract.

import type { ErrorEnvelope } from "./types.js";

export class Tfl5Error extends Error {
  /** Stable machine code, e.g. "access_denied". */
  readonly code: string;
  /** HTTP status the server returned (0 if the request never completed). */
  readonly status: number;
  /** Raw error envelope for callers that need extra fields. */
  readonly body: ErrorEnvelope;

  constructor(code: string, message: string, status: number, body: ErrorEnvelope) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — session missing/expired (`isSignout:true`). */
export class UnauthorizedError extends Tfl5Error {}
/**
 * Caller is authenticated but lacks the required level on the target.
 *
 * ⚠ **Do not branch on the HTTP status.** An ACL denial is still HTTP **200**
 * with `code: "access_denied"` (`error.rs:346-349`), so a client that checks
 * `res.ok` sees success — this is exactly why the SDK classifies on `code`
 * and throws. Its {@link TokenScopeDeniedError} subclass, meanwhile, arrives
 * as a genuine 403, and business refusals moved off 200 to their own statuses
 * (409 and friends) with `TFL5_LEGACY_REFUSAL_200=1` available to operators as
 * a revert (`error.rs:249`). Any of those statuses can therefore change under
 * a client that hard-codes one. Match on `code` and on the class.
 */
export class AccessDeniedError extends Tfl5Error {}
/** 200 — resource/doc/row not found. */
export class NotFoundError extends Tfl5Error {}
/** 400 — malformed request / validation failure. */
export class BadRequestError extends Tfl5Error {}
/** 429 — rate limited; `retryAfter` seconds when the server sent it. */
export class RateLimitError extends Tfl5Error {
  readonly retryAfter?: number;
  constructor(
    code: string,
    message: string,
    status: number,
    body: ErrorEnvelope,
    retryAfter?: number,
  ) {
    super(code, message, status, body);
    this.retryAfter = retryAfter;
  }
}
/**
 * 402 — a spend or an allowance was refused. The request was well-formed and
 * the caller was permitted; there was simply no capacity left to satisfy it.
 *
 * The remedy is to acquire more (buy, raise the cap, free a slot) or to wait,
 * never to fix the request — which is why this is its own class and not a
 * {@link BadRequestError}. **Four** server codes land here, raised from six
 * sites (the whole 402 census in `crates/`):
 *
 * | `code`                 | Sites                        | Meaning                                   |
 * |------------------------|------------------------------|-------------------------------------------|
 * | `quota_exceeded`       | `app.rs:800`, `:858`         | app-creation allowance spent — TWO caps   |
 * | `domain_quota_reached` | `domain.rs:672`, `:1008`     | no custom-domain slot free                |
 * | `insufficient_credits` | `credits.rs:859`             | metered spend refused for lack of balance |
 * | `proj_keys_quota`      | `durable_proj.rs:559`        | live projection-subscription keys spent   |
 *
 * `quota_exceeded` is one code over two different caps — a CONSUMABLE
 * app-creation right and a CONCURRENT app-count limit. They call for opposite
 * advice, so read {@link cap} / {@link refundableOnDelete} before telling a
 * user what to do about it.
 *
 * ## ⚠ Match on `code`, not on the 402
 *
 * The status is corroboration, not the key. **Four of the six sites** build
 * their refusal through `AppError::Refused`, which an operator can revert to
 * HTTP **200** process-wide with `TFL5_LEGACY_REFUSAL_200=1` (or `=true`) —
 * `error.rs:256-263`, `:373-383`. The other two (`insufficient_credits` at
 * `credits.rs:859`, `proj_keys_quota` at `durable_proj.rs:559`) build the
 * response directly, bypass `AppError` entirely and ignore that flag, because
 * `AppError` has no 402 variant to carry the exact status.
 *
 * So under the revert, `quota_exceeded` and `domain_quota_reached` arrive as
 * **200** while credits and projection keys stay **402** — and a classifier
 * keyed on the number alone would silently miss two of the four codes, on a
 * flag no client can see. {@link makeError} therefore keys on `code` first
 * and treats 402 only as a fallback for codes it does not know.
 *
 * ## Payload
 *
 * Only `quota_exceeded` carries a `data` block, and its shape depends on
 * which cap was hit (`app.rs:808-814`, `:865-870`). The rest send none, so
 * every accessor here is optional — read {@link refundableOnDelete} before
 * telling a user to delete something.
 */
export class PaymentRequiredError extends Tfl5Error {
  /**
   * Which cap was hit — `"app_create_rights"` or `"user_max_apps"` on a
   * `quota_exceeded`. `undefined` on every other 402, which sends no payload.
   */
  readonly cap?: string;
  /**
   * Whether deleting something frees capacity.
   *
   * This is the difference between two refusals that used to share one
   * message: `user_max_apps` is a CONCURRENT cap, so deleting an app frees a
   * slot straight away (`true`), while `app_create_rights` is CONSUMABLE —
   * rights are spent on creation and deleting gives nothing back (`false`).
   * Telling a user to delete an app in the second case sends them to do
   * something that cannot work.
   *
   * `undefined` when the server sent no payload — do not treat that as
   * `false`.
   */
  readonly refundableOnDelete?: boolean;
  /**
   * The raw `data` block, for the per-cap numbers this class does not
   * normalise: `{rights, created, remaining}` for `app_create_rights`,
   * `{max, used}` for `user_max_apps`. Deliberately not flattened into one
   * shape — the two caps count different things and a shared field name
   * would invite showing the wrong number.
   */
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, body: ErrorEnvelope) {
    super(code, message, status, body);
    // Narrowed from `unknown` rather than read straight off the envelope, so
    // this compiles whether or not `ErrorEnvelope` declares `data`.
    const data = (body as { data?: unknown }).data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      this.details = d;
      if (typeof d["cap"] === "string") this.cap = d["cap"];
      if (typeof d["refundable_on_delete"] === "boolean") {
        this.refundableOnDelete = d["refundable_on_delete"];
      }
    }
  }
}

/** 5xx — server-side failure. */
export class InternalError extends Tfl5Error {}

/**
 * 403 `token_scope_denied` — a service token was presented that IS scoped,
 * and its scopes do not cover the path.
 *
 * Extends {@link AccessDeniedError} deliberately: this is an authorisation
 * refusal, so `catch (e) { if (e instanceof AccessDeniedError) … }` must fire
 * for it. Before this class existed the 403 fell through to
 * {@link BadRequestError} and that branch never ran.
 *
 * Service-token scopes are enforced by a middleware mounted on the whole
 * router (`crates/routes/src/lib.rs:279`), so this can surface on ANY
 * endpoint, not just the one you are calling. It only ever comes from a token
 * carrying at least one path-shaped scope: a token with no scopes at all is
 * grandfathered through as unrestricted, and so is one whose scopes are all
 * legacy dot-named labels this gate cannot evaluate. Cookie sessions and
 * non-`st_` bearers never reach the check.
 *
 * Fix it by re-minting the token with a scope that covers {@link path} — not
 * by granting the subject more permission, which is unrelated.
 */
export class TokenScopeDeniedError extends AccessDeniedError {
  /** The request path the token was refused for. */
  readonly path?: string;
  /**
   * The token's FULL stored scope list.
   *
   * ⚠ Not the same set the server's message names. `msg` lists only the
   * scopes the gate could actually EVALUATE (path-shaped: `"*"` or starting
   * with `/`), whereas this echoes everything stored, including legacy
   * dot-named labels like `"app.list"` that are unenforceable and were
   * ignored in the decision. A diff between the two is normal on an older
   * token; do not present this array as "the scopes that were checked".
   */
  readonly scopes?: string[];

  constructor(code: string, message: string, status: number, body: ErrorEnvelope) {
    super(code, message, status, body);
    // `data` is not on ErrorEnvelope, but the HTTP layer hands `makeError`
    // the whole parsed body, so the field is there at runtime.
    const data = (body as { data?: { path?: unknown; scopes?: unknown } }).data;
    this.path = typeof data?.path === "string" ? data.path : undefined;
    this.scopes = Array.isArray(data?.scopes)
      ? data.scopes.filter((s): s is string => typeof s === "string")
      : undefined;
  }
}

/**
 * 503 `token_scope_unavailable` — the scope lookup itself failed, so the
 * server could not decide and **refused rather than waving the request
 * through**. Waving it through would turn a transient database outage into an
 * authorisation bypass, which is the one failure mode that gate exists to
 * stop.
 *
 * A distinct class rather than {@link InternalError} because the two call for
 * opposite responses: this is a transient, retryable condition and nothing is
 * wrong with your request, whereas an `InternalError` is a server bug worth
 * reporting. Classified as `InternalError`, retry logic that (correctly)
 * refuses to retry 5xx server bugs would give up on a request that would
 * succeed a moment later.
 *
 * Retry with backoff. If it persists, the platform's token store is unhealthy
 * — escalate rather than re-minting tokens.
 */
export class TokenScopeUnavailableError extends Tfl5Error {
  /** Marker for retry helpers: this condition is transient by construction. */
  readonly retryable = true;
}

/** Map a `(status, code)` pair onto the right subclass. */
export function makeError(
  status: number,
  body: ErrorEnvelope,
  retryAfter?: number,
): Tfl5Error {
  const code = body.code ?? (status >= 500 ? "internal" : "bad_request");
  const msg = body.msg ?? code;
  switch (code) {
    case "unauthorized":
      return new UnauthorizedError(code, msg, status, body);
    case "access_denied":
      return new AccessDeniedError(code, msg, status, body);
    case "not_found":
      return new NotFoundError(code, msg, status, body);
    case "rate_limit_exceeded":
      return new RateLimitError(code, msg, status, body, retryAfter);
    // Service-token scope refusals (HTTP 403 / 503). Both need explicit arms:
    // the `default:` below buckets by status, which sent the 403 to
    // BadRequestError — so `instanceof AccessDeniedError` never fired on an
    // authorisation refusal — and the 503 to InternalError, so a retryable
    // outage read as a server bug.
    case "token_scope_denied":
      return new TokenScopeDeniedError(code, msg, status, body);
    case "token_scope_unavailable":
      return new TokenScopeUnavailableError(code, msg, status, body);
    // Capacity refusals. Keyed on `code`, NOT on the 402, because
    // `TFL5_LEGACY_REFUSAL_200=1` sends `quota_exceeded` and
    // `domain_quota_reached` back to HTTP 200 while the other two stay 402 —
    // a status branch would misclassify half of them on a flag no client can
    // observe. See PaymentRequiredError for the full census.
    case "quota_exceeded":
    case "domain_quota_reached":
    case "insufficient_credits":
    case "proj_keys_quota":
      return new PaymentRequiredError(code, msg, status, body);
    case "internal":
      return new InternalError(code, msg, status, body);
    default:
      // Unknown / future code: bucket by HTTP status so callers still get
      // a sensible class, while `.code` preserves the exact server value.
      if (status === 401 || body.isSignout) return new UnauthorizedError(code, msg, status, body);
      if (status === 429) return new RateLimitError(code, msg, status, body, retryAfter);
      if (status === 402) return new PaymentRequiredError(code, msg, status, body);
      if (status >= 500) return new InternalError(code, msg, status, body);
      return new BadRequestError(code, msg, status, body);
  }
}
