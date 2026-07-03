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
/** 200 — caller authenticated but lacks ACL on the target. */
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
/** 5xx — server-side failure. */
export class InternalError extends Tfl5Error {}

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
    case "internal":
      return new InternalError(code, msg, status, body);
    default:
      // Unknown / future code: bucket by HTTP status so callers still get
      // a sensible class, while `.code` preserves the exact server value.
      if (status === 401 || body.isSignout) return new UnauthorizedError(code, msg, status, body);
      if (status === 429) return new RateLimitError(code, msg, status, body, retryAfter);
      if (status >= 500) return new InternalError(code, msg, status, body);
      return new BadRequestError(code, msg, status, body);
  }
}
