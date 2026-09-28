# Errors

Every failed call rejects with a `Tfl5Error`. Branch on its class or on
`err.code` — a stable machine code. Never match on `err.message`: the server
may reword or translate it.

```ts
import { Tfl5Error, NotFoundError, AccessDeniedError, UnauthorizedError, RateLimitError } from "@tfl5/sdk";

try {
  await tfl5.resource("task").update(tid, data);
} catch (e) {
  if (e instanceof UnauthorizedError) return goToLogin();
  if (e instanceof AccessDeniedError) return showForbidden();
  if (e instanceof RateLimitError) return retryAfter(e.retryAfter);
  if (e instanceof Tfl5Error && e.code === "hook_validation_failed") return showMessage(e.message);
  throw e;
}
```

| STT | Class | `code` | Meaning |
|---|---|---|---|
| 1 | `UnauthorizedError` | `unauthorized` | not signed in, or the session expired |
| 2 | `AccessDeniedError` | `access_denied` | signed in, but not allowed |
| 3 | `NotFoundError` | `not_found` | the target does not exist (or you may not know it exists) |
| 4 | `RateLimitError` | `rate_limit_exceeded` | slow down; `retryAfter` is in seconds when the server sent it |
| 5 | `PaymentRequiredError` | `quota_exceeded`, `domain_quota_reached`, `insufficient_credits`, `proj_keys_quota` | a plan limit or balance; `refundableOnDelete` says whether deleting an app frees a slot |
| 6 | `TokenScopeDeniedError` (an `AccessDeniedError`) | `token_scope_denied` | a service token's scopes do not cover this path (`path`, `scopes`) |
| 7 | `TokenScopeUnavailableError` | `token_scope_unavailable` | the token check could not run; retry (`retryable` is true) |
| 8 | `InternalError` | `internal` | a server fault; details are logged server-side, not returned |
| 9 | `BadRequestError` | everything else | the request was refused; `code` says why |

Every error carries `code`, `status` (the HTTP status, `0` if the request
never completed) and `body` (the raw error envelope, which sometimes holds
extra fields such as `body.data` or `body.app_tids`).

Do not rely on the HTTP status to detect failure: some refusals are answered
with HTTP 200 and `result: false`, and the status of a given refusal may
change between server versions. The SDK looks at the response body, so the
class and `code` stay stable.

## Codes you will meet

| STT | `code` | When |
|---|---|---|
| 1 | `email_not_verified` | the account must verify its email before this write |
| 2 | `validation_invalid`, `field_validation_failed` | a field failed its validator |
| 3 | `hook_validation_failed` | a `require_fields` hook refused the write |
| 4 | `cannot_filter_encrypted_field` | a `where` filter named a level-1/2 field |
| 5 | `offset_too_deep`, `cursor_invalid` | paging: use `listPage()` and its cursor |
| 6 | `quota_app_max_storage` | the app's storage allowance is used up |
| 7 | `file_write_shadowed_by_snapshot` | (strict servers) a release-stage file write under a live site |
| 8 | `file_too_large`, `file_extension_not_allowed` | an upload was refused |
| 9 | `conflict` | a concurrent change won; read again and retry |
| 10 | `durable_disabled` | durable operators are off on this server |

The server's full list is longer; unknown codes arrive as `BadRequestError`
with the exact `code` preserved.

## Things that resolve instead of throwing

A few calls report an expected "did not happen" as a value rather than an
error, because the caller normally handles it inline:

- `durable.send()` → `{ result: false, code, retryable, … }` for delivery
  outcomes (busy, wrong cell, quota, deadline); other refusals throw
- `stages.promote()`, `stages.releaseStatus()`, `stages.rollbackRelease()` →
  `{ result: false, msg }`
- `site.get()` / `site.blob()` → `null` when the path or blob does not exist;
  `site.delete()` → `false` when the path was not in the draft
