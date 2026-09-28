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
 * Caller is signed in but not allowed. Usually answered with HTTP 200 and
 * `result: false` — match on the class or `code`, not on the status.
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
 * A capacity refusal: `quota_exceeded` (no app slot or creation right left),
 * `domain_quota_reached`, `insufficient_credits`, `proj_keys_quota`. Usually
 * HTTP 402; the class is chosen by `code`, because some deployments answer
 * these with HTTP 200.
 *
 * Only `quota_exceeded` carries details. `refundableOnDelete` says whether
 * deleting an app frees capacity: `true` for the concurrent `user_max_apps`
 * cap, `false` for consumable `app_create_rights`. Check it before telling a
 * user to delete something; `undefined` means the server did not say.
 */
export class PaymentRequiredError extends Tfl5Error {
  /** `"app_create_rights"` or `"user_max_apps"` on `quota_exceeded`. */
  readonly cap?: string;
  readonly refundableOnDelete?: boolean;
  /** The raw `data` block (`{rights, created, remaining}` or `{max, used}`). */
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, body: ErrorEnvelope) {
    super(code, message, status, body);
    const data = body.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      this.details = d;
      if (typeof d["cap"] === "string") this.cap = d["cap"];
      if (typeof d["refundable_on_delete"] === "boolean") this.refundableOnDelete = d["refundable_on_delete"];
    }
  }
}

/** 5xx — server-side failure. */
export class InternalError extends Tfl5Error {}

/**
 * 403 `token_scope_denied` — a scoped service token was used on a path its
 * scopes do not cover. It is an authorisation refusal, so it is also an
 * `AccessDeniedError`. Fix it by using a token whose scopes cover `path`.
 */
export class TokenScopeDeniedError extends AccessDeniedError {
  /** The request path the token was refused for. */
  readonly path?: string;
  /** The token's full stored scope list (including labels the check ignores). */
  readonly scopes?: string[];

  constructor(code: string, message: string, status: number, body: ErrorEnvelope) {
    super(code, message, status, body);
    const data = body.data as { path?: unknown; scopes?: unknown } | undefined;
    this.path = typeof data?.path === "string" ? data.path : undefined;
    this.scopes = Array.isArray(data?.scopes)
      ? data.scopes.filter((s): s is string => typeof s === "string")
      : undefined;
  }
}

/**
 * 503 `token_scope_unavailable` — the server could not check the token's
 * scopes and refused rather than let the request through. Transient: retry
 * with back-off (unlike `InternalError`, which signals a server bug).
 */
export class TokenScopeUnavailableError extends Tfl5Error {
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
    case "token_scope_denied":
      return new TokenScopeDeniedError(code, msg, status, body);
    case "token_scope_unavailable":
      return new TokenScopeUnavailableError(code, msg, status, body);
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
