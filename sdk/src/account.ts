// AccountClient — the signed-in user's OWN account: `/user/*` (profile,
// password, username, provider linking, multi-email management) and
// `/user/2fa/*` (TOTP enrolment / verify / disable). Every endpoint is
// scoped to the caller's own row — there is no admin-override form here
// (see the operator/admin surface for cross-user account management).
//
// Right-to-access / right-to-erasure (`/user/data/export`, `/user/data/erase`,
// `/user/data/erase/cancel`) are NOT in this file — they already live on
// {@link AuthClient} (`./auth.js`) as `exportData()` / `eraseAccount()` /
// `cancelErase()`; don't re-implement them here.
//
// ---------------------------------------------------------------------
// GOTCHA — silent "not signed in" on every /user/* endpoint (verified):
// ---------------------------------------------------------------------
// Every handler behind this client answers a missing/expired session with
// HTTP 200 and body `{isSignout:true, result:true}` instead of HTTP 401
// (crates/routes/src/user.rs, e.g. lines 1187, 1359, 1505, 1649, 1776,
// 1876, 2150, 2269, 2303, 2419, 2509, 2638 — one per handler below).
// Because the body still carries `result:true`, the transport's generic
// envelope-unwrap treats it as an ordinary SUCCESS and resolves instead of
// throwing. Left alone, every method here would silently resolve with a
// meaningless partial object on an expired session rather than failing
// loudly. `assertSignedIn()` below closes that gap by turning it into a
// real thrown {@link UnauthorizedError}, matching what a 401 would give you
// anywhere else in the SDK. (2FA endpoints don't need this — `two_fa.rs`'s
// `caller()` helper throws a real `AppError::Unauthorized` instead of this
// 200-with-marker shape.)
//
// ---------------------------------------------------------------------
// GOTCHA — `/user/profile` and `/user/email/list` don't use the `data`
// envelope key:
// ---------------------------------------------------------------------
// `user_profile` wraps its payload under `"user"` (user.rs:1255-1288) and
// `user_email_list` wraps its payload under `"emails"` (user.rs:2275-2279)
// — NOT under `"data"` like every other endpoint in the SDK. The generic
// transport only unwraps a literal `data` key, so `profile()`/`emailList()`
// below extract `.user`/`.emails` explicitly rather than relying on that.

import { UnauthorizedError } from "./errors.js";
import type { ErrorEnvelope } from "./types.js";
import type { HttpCore } from "./http.js";

/**
 * See {@link assertSignedIn} above the class for why this exists. Applied to
 * every `/user/*` call in this file (not the `/user/2fa/*` ones, which throw
 * a real 401 already).
 */
function assertSignedIn<T>(body: T): T {
  if ((body as { isSignout?: boolean }).isSignout) {
    throw new UnauthorizedError(
      "unauthorized",
      "Not signed in (session missing or expired)",
      200,
      body as unknown as ErrorEnvelope,
    );
  }
  return body;
}

// ---- Profile types --------------------------------------------------------

export interface AccountLicenseTier {
  tid: string;
  name: string;
  description?: string | null;
  user_max_apps: number;
  /** Bytes. */
  user_max_total_storage: number;
  /** Bytes per app. */
  app_max_storage: number;
}

/** One entry from the multi-email list embedded in {@link Profile} and
 *  returned by `emailList()`. */
export interface UserEmail {
  /** Hex-encoded SHA-256 of the canonical address. Use as the key for
   *  `emailRemove` / `emailPromotePrimary` / `emailSendVerification`. */
  email_hash: string;
  /** Decrypted address, or `null` — check {@link unreadable} on this same
   *  row before treating `null` as "no address": it's only that if
   *  `unreadable` is `false`. When `unreadable` is `true`, the row exists
   *  and its ciphertext is sitting right there — this process just can't
   *  open it right now (e.g. a master-key rotation whose backfill hasn't
   *  finished), which is a very different fact than "never added". */
  email: string | null;
  /** `true` when this row's ciphertext exists but could not be decrypted
   *  — `email` is `null` for a reason that is NOT "no address entered".
   *  `false` on every healthy row. */
  unreadable: boolean;
  is_primary: boolean;
  verified: boolean;
  /** Epoch-ms. */
  added_at: number;
  /** Epoch-ms, or `null` when not yet verified. */
  verified_at: number | null;
}

/**
 * Full profile as returned by `profile()` (`POST /user/profile`).
 *
 * READ {@link unreadable} BEFORE TRUSTING A `null` ON `email`/`name`/
 * `mobile`. Those three columns are field-level encrypted; `null` used to
 * mean only one thing ("never set"), but a column whose ciphertext exists
 * and simply can't be opened right now (an unfinished master-key rotation,
 * a retired secondary key) decrypts to the exact same `null` — silently,
 * with nothing else on the wire to tell the two apart. `unreadable` closes
 * that gap: a `null` field is only "not filled in" if that field's name is
 * ABSENT from `unreadable`. Present in `unreadable` + `null` value means
 * "there IS a value here, this response just couldn't decrypt it" — show
 * "temporarily unavailable", never an empty/placeholder state that reads
 * as "add your email".
 */
export interface Profile {
  tid: string;
  username: string;
  license_tid: string;
  license: AccountLicenseTier | null;
  /** Decrypted primary email address. See the interface-level note on
   *  {@link unreadable} before treating `null` as "not set". */
  email: string | null;
  /** Decrypted display name. See the interface-level note on
   *  {@link unreadable} before treating `null` as "not set". */
  name: string | null;
  /** Decrypted mobile number. See the interface-level note on
   *  {@link unreadable} before treating `null` as "not set". */
  mobile: string | null;
  /**
   * Names of the top-level PII fields above (`"email"`, `"name"`,
   * `"mobile"`) whose ciphertext is present but could not be decrypted on
   * this call. Empty array on every healthy account — additive, so code
   * that ignores it behaves exactly as before. Non-empty is itself a
   * signal worth surfacing (e.g. to an admin), independent of which UI
   * field it affects.
   */
  unreadable: string[];
  email_verified: boolean;
  /** All email addresses (primary + secondaries), primary-first. */
  emails: UserEmail[];
  /** e.g. `["password"]`, `["google"]`, `["password","google"]`. */
  auth_methods: string[];
  /** Whether the account can sign in with a password yet — drives
   *  "Set password" vs "Change password" in the UI for passwordless
   *  accounts (`'password' ∈ auth_methods`, same test). */
  has_password: boolean;
  app_count: number;
  /** Bytes used across all apps the user owns. */
  total_used_storage: number;
  /** Epoch-ms. */
  created_at: number;
  /** Epoch-ms of a pending right-to-erasure request, or `null` if none. */
  erase_requested_at: number | null;
  /** Epoch-ms when a pending erasure will run (`erase_requested_at` +
   *  the server's grace window), or `null` if none is pending. */
  erase_after: number | null;
}

export interface ProfileUpdateInput {
  /**
   * Pass a non-empty string to set, an empty string to clear, or omit to
   * leave unchanged.
   */
  name?: string;
  mobile?: string;
}

// ---- Password types --------------------------------------------------------

export interface ChangePasswordInput {
  current: string;
  new: string;
  re_new: string;
}

export interface SetPasswordInput {
  new: string;
  /** Optional — enforced only when sent (must equal `new` if present). */
  re_new?: string;
  /** TOTP or backup code — required only when the account has a
   *  CONFIRMED 2FA enrolment (see `setPassword`'s doc for the `totp_required` flow). */
  code?: string;
}

// ---- Link-provider result --------------------------------------------------

export interface LinkProviderResult {
  /** The account's full auth_methods array after linking. */
  auth_methods: string[];
}

// ---- 2FA types --------------------------------------------------------------

/** Status returned by `twoFaStatus()`. */
export interface TwoFaStatus {
  enrolled: boolean;
  /** True only after `twoFaConfirm()` succeeds. */
  confirmed: boolean;
  /** Epoch-ms, or null when never enrolled. */
  enrolled_at: number | null;
  /** Epoch-ms of last successful TOTP or backup-code use. */
  last_used_at?: number | null;
  /** Unused backup codes remaining. */
  backup_codes_remaining: number;
}

/** Response from `twoFaEnroll()`. */
export interface TwoFaEnrollResult {
  /** `otpauth://` URI — render as a QR code for authenticator apps. */
  provisioning_uri: string;
  /**
   * Raw base32 secret for manual entry, and the one-time backup codes.
   * **Shown exactly once, right here — no endpoint can ever re-reveal
   * either of these.** If the user navigates away before saving them,
   * the only recovery is to call `twoFaEnroll()` again, which mints a
   * FRESH secret + codes and immediately invalidates the old ones (the
   * server refuses to re-enroll over an already-CONFIRMED 2FA — see the
   * `twofa_already_confirmed` note below — so this only helps before the
   * first `twoFaConfirm()`).
   */
  secret_base32: string;
  /** One-time backup codes. Shown once; never re-fetchable (same as above). */
  backup_codes: string[];
  confirmed: false;
}

/** Response from `twoFaConfirm()`. */
export interface TwoFaConfirmResult {
  confirmed: boolean;
}

/** Response from `twoFaVerify()`. */
export interface TwoFaVerifyResult {
  verified: boolean;
  /** Epoch-ms when the `_2fa_verified` cookie expires. */
  valid_until: number;
}

/** Response from `twoFaDisable()`. */
export interface TwoFaDisableResult {
  disabled: boolean;
  /** `false` when there was nothing enrolled to disable (a no-op success). */
  was_enrolled?: boolean;
}

/** Response from `twoFaRegenerateBackupCodes()`. */
export interface TwoFaRegenerateResult {
  /** Fresh backup codes. All previous codes are now invalid. */
  backup_codes: string[];
}

// ---- Email-address management types ----------------------------------------

export interface EmailAddInput {
  email: string;
}

export interface EmailAddResult {
  email_hash: string;
}

export interface EmailByHashInput {
  /** Hex-encoded SHA-256 from {@link UserEmail.email_hash}. */
  email_hash: string;
}

// ---- Client -----------------------------------------------------------------

export class AccountClient {
  constructor(private readonly http: HttpCore) {}

  // ---- Profile ------------------------------------------------------------

  /**
   * Fetch the extended profile for the authenticated user: decrypted email,
   * name, mobile, license tier, all email addresses, auth methods, storage,
   * and app count.
   *
   * Throws {@link UnauthorizedError} if the session is missing/expired (see
   * the file-header gotcha — the server answers that case with HTTP 200,
   * this method converts it to a real rejection).
   */
  async profile(): Promise<Profile> {
    const body = assertSignedIn(await this.http.post<{ user?: Profile }>("/user/profile"));
    if (!body.user) throw new Error("@tfl5/sdk: /user/profile returned no user payload");
    return body.user;
  }

  /**
   * Update the authenticated user's display name and/or mobile number.
   * Pass `name: ""` or `mobile: ""` to clear the field; omit to leave
   * unchanged. Always succeeds (there is no failure code for this endpoint).
   */
  async updateProfile(input: ProfileUpdateInput): Promise<void> {
    assertSignedIn(await this.http.post("/user/profile/update", input));
  }

  /**
   * Change the authenticated user's password. Requires the current password.
   * Bumps `token_epoch` (logs out every OTHER session) and re-mints this
   * session's cookie.
   *
   * Throws on: wrong current password, new password too short (<6 chars),
   * `new` ≠ `re_new`, or an account with no `'password'` in `auth_methods`
   * — i.e. ANY passwordless account (magic-link, phone OTP, QR, Google,
   * Microsoft — not only Google). None of these carry a `.code`, only a
   * human message; use {@link setPassword} instead for a passwordless account.
   */
  async changePassword(input: ChangePasswordInput): Promise<void> {
    assertSignedIn(await this.http.post("/user/change-password", input));
  }

  /**
   * Give a PASSWORDLESS account (magic-link / OAuth / phone / QR) its first
   * password so it isn't locked to one sign-in method. No old password is
   * required — the active session is the proof.
   *
   * If the account has a CONFIRMED 2FA enrolment, the first call is refused
   * with `code: "totp_required"`; re-call with `{ ...input, code }` (a TOTP
   * or backup code) to complete. An account that already has a password is
   * refused with `code: "has_password"` — use {@link changePassword} instead.
   * Both refusals throw a {@link BadRequestError}-shaped `Tfl5Error`; branch
   * on `.code`. Plain validation failures (too short / mismatch) throw with
   * no `.code`.
   */
  async setPassword(input: SetPasswordInput): Promise<void> {
    assertSignedIn(await this.http.post("/user/set-password", input));
  }

  /**
   * Rename the account's login username. ACL membership is keyed on the
   * stable user id, so permissions are preserved; legacy `apps.author` rows
   * keyed by the old username are migrated in the same transaction. Every
   * OTHER session is signed out (their cookies carried the old name); this
   * session's cookie is re-minted.
   *
   * Throws (no `.code`, message only) if the name is <2 chars, unchanged,
   * or already taken (including a race lost against a concurrent rename).
   */
  async changeUsername(newUsername: string): Promise<string> {
    const body = assertSignedIn(
      await this.http.post<{ username?: string }>("/user/username/change", {
        new_username: newUsername,
      }),
    );
    return body.username ?? newUsername;
  }

  /**
   * Connect a Google or Microsoft identity to the CURRENT signed-in account.
   * `credential` is the provider's ID token (GIS credential / MSAL idToken).
   *
   * Linking is EMAIL-based: the provider's verified email must match one of
   * this account's own emails (primary or a verified secondary) — a
   * different-email identity is refused with `code: "email_mismatch"` rather
   * than silently merged into this login. Only `"google"` / `"microsoft"`
   * are accepted providers.
   */
  async linkProvider(
    provider: "google" | "microsoft",
    credential: string,
  ): Promise<LinkProviderResult> {
    const body = assertSignedIn(
      await this.http.post<{ auth_methods?: string[] }>("/user/link", { provider, credential }),
    );
    return { auth_methods: body.auth_methods ?? [] };
  }

  /**
   * Trigger a verification email to the authenticated user's PRIMARY email
   * address. Requires Mailler + `TFL5_NOREPLY_FROM` configured server-side.
   * No-op (still resolves) if already verified.
   */
  async sendVerification(): Promise<void> {
    assertSignedIn(await this.http.post("/user/send-verification"));
  }

  // ---- 2FA ------------------------------------------------------------------
  //
  // Every /user/2fa/* endpoint requires an authenticated session and is
  // gated to the caller's OWN row (the username on the auth cookie/bearer
  // wins; the request body never names a user). Unlike the plain /user/*
  // endpoints above, a missing session here throws a REAL 401
  // (two_fa.rs's `caller()` uses `AppError::Unauthorized`, not the
  // isSignout-200 shape) — no `assertSignedIn` needed.

  /**
   * Return the current 2FA enrolment state: `enrolled`, `confirmed`,
   * `enrolled_at`, `last_used_at`, `backup_codes_remaining`. Never leaks
   * the secret or backup codes.
   */
  twoFaStatus(): Promise<TwoFaStatus> {
    return this.http.post<TwoFaStatus>("/user/2fa/status");
  }

  /**
   * Start TOTP enrolment: generates a NEW secret + 8 backup codes, persists
   * them encrypted, and returns the `otpauth://` provisioning URI (render as
   * a QR code), the raw base32 secret (manual-entry fallback), and the
   * plaintext backup codes.
   *
   * **The secret and backup codes are returned ONLY HERE and can never be
   * re-fetched by any endpoint** — capture them before the user navigates
   * away. The enrolment is not active until {@link twoFaConfirm} succeeds
   * (`confirmed` stays `false` until then).
   *
   * Refuses with `code: "twofa_already_confirmed"` if 2FA is already
   * confirmed on this account — call {@link twoFaDisable} first (which
   * requires proof-of-possession) before re-enrolling; this stops a merely
   * *authenticated* (but possibly hijacked) session from silently rebinding
   * an already-protected account's 2FA with no proof of the old factor.
   * Re-enrolling over an UNCONFIRMED prior enrolment is allowed and simply
   * overwrites it.
   */
  twoFaEnroll(): Promise<TwoFaEnrollResult> {
    return this.http.post<TwoFaEnrollResult>("/user/2fa/enroll");
  }

  /**
   * Confirm the TOTP enrolment with the first valid 6-digit code from the
   * authenticator app. Stamps `confirmed_at`; the 2FA gate now takes effect
   * for this user (required to unlock `/admin/*` when the server has
   * `TFL5_REQUIRE_2FA_FOR_ADMIN` on).
   */
  twoFaConfirm(code: string): Promise<TwoFaConfirmResult> {
    return this.http.post<TwoFaConfirmResult>("/user/2fa/confirm", { code });
  }

  /**
   * In-session step-up challenge. Accepts a fresh 6-digit TOTP or a
   * one-shot backup code. On success issues the `_2fa_verified` cookie
   * (valid for the server's `twofa_verify_ttl_ms`, default 30 min).
   *
   * **Rate-limited with a HARD LOCKOUT, not just a soft rate limit:** after
   * 5 failed attempts inside a rolling 15-minute window, EVERY further
   * attempt — including a subsequently correct code — is refused with HTTP
   * 429 (`code: "twofa_locked"`) until the oldest failure ages out of the
   * window. **Do not blindly retry on 429** — back off and surface the
   * lockout to the user.
   *
   * Gotcha verified in code: unlike the SDK's generic 429 handling
   * elsewhere, this specific lockout response does NOT set an HTTP
   * `Retry-After` header — the wait hint ships only as `retry_after_ms` in
   * the JSON body. `RateLimitError.retryAfter` (which is populated purely
   * from the header) will therefore be `undefined` here; read
   * `(err as RateLimitError).body.retry_after_ms` instead.
   */
  twoFaVerify(code: string): Promise<TwoFaVerifyResult> {
    return this.http.post<TwoFaVerifyResult>("/user/2fa/verify", { code });
  }

  /**
   * Disable 2FA. Requires proof-of-possession: a valid TOTP or backup code.
   * Removes the enrolment row and clears the `_2fa_verified` cookie.
   * Resolves `{disabled:true, was_enrolled:false}` (not an error) if there
   * was nothing enrolled to disable.
   */
  twoFaDisable(code: string): Promise<TwoFaDisableResult> {
    return this.http.post<TwoFaDisableResult>("/user/2fa/disable", { code });
  }

  /**
   * Replace the backup codes. Requires proof-of-possession: a valid TOTP or
   * an existing backup code. All previous backup codes are invalidated
   * immediately. The new codes are shown once, exactly like {@link twoFaEnroll}.
   */
  twoFaRegenerateBackupCodes(code: string): Promise<TwoFaRegenerateResult> {
    return this.http.post<TwoFaRegenerateResult>("/user/2fa/regenerate-backup-codes", { code });
  }

  // ---- Email-address management ----------------------------------------------

  /**
   * List all email addresses for the authenticated user (primary +
   * secondaries), sorted primary-first then by `added_at`. Each entry
   * carries `email_hash` (hex SHA-256) for use as the key in
   * {@link emailRemove} / {@link emailPromotePrimary} / {@link emailSendVerification}.
   */
  async emailList(): Promise<UserEmail[]> {
    const body = assertSignedIn(
      await this.http.post<{ emails?: UserEmail[] }>("/user/email/list"),
    );
    return body.emails ?? [];
  }

  /**
   * Add a secondary email address. Automatically fires a verification email
   * (best-effort — a mailler outage doesn't fail the add; retry via
   * {@link emailSendVerification}). The row stays unverified until the user
   * clicks the link; {@link emailPromotePrimary} refuses an unverified row.
   *
   * Throws `code: "validation_invalid"` for an implausible address, or
   * `code: "validation_email_taken"` if the address already belongs to any
   * account (as a primary OR as another account's secondary — deliberately
   * collapsed to one code so a caller can't enumerate which surface owns it).
   */
  async emailAdd(input: EmailAddInput): Promise<EmailAddResult> {
    const body = assertSignedIn(
      await this.http.post<{ email_hash?: string }>("/user/email/add", input),
    );
    return { email_hash: body.email_hash ?? "" };
  }

  /**
   * Remove a secondary email. Identified by hex `email_hash` (from
   * {@link emailList}). Refuses the PRIMARY address (`code:
   * "validation_email_primary"` — promote another one first) and an unknown
   * hash, including one that belongs to a different user (both collapse to
   * `code: "not_found"` so a caller can't probe other accounts' hashes).
   */
  async emailRemove(input: EmailByHashInput): Promise<void> {
    assertSignedIn(await this.http.post("/user/email/remove", input));
  }

  /**
   * Promote a verified secondary email to primary. Refuses an unverified
   * candidate (`code: "validation_email_unverified"`) and an unknown/foreign
   * hash (`code: "not_found"`). Calling it on the CURRENT primary is a no-op
   * success (`msg: "Already primary"`), not an error.
   *
   * Updates `users.email_*` in the same transaction so password reset,
   * Google/Microsoft linking, and `profile()` all see the new primary
   * immediately.
   */
  async emailPromotePrimary(input: EmailByHashInput): Promise<void> {
    assertSignedIn(await this.http.post("/user/email/promote-primary", input));
  }

  /**
   * Resend the verification link for any email address the caller owns
   * (primary or secondary), identified by hex `email_hash`. Refuses an
   * unknown/foreign hash (`code: "not_found"`); an already-verified row
   * fails with a plain message and no `.code`.
   */
  async emailSendVerification(input: EmailByHashInput): Promise<void> {
    assertSignedIn(await this.http.post("/user/email/send-verification", input));
  }
}
