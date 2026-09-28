// AccountClient — per-authenticated-user profile, password, email management,
// and TOTP 2FA. All endpoints are scoped to the calling user; no app_tid needed.
//
// Endpoints:
//   POST /user/profile                        — extended profile (PII decrypted)
//   POST /user/profile/update                 — update name / mobile
//   POST /user/change-password                — change password (requires current)
//   POST /user/send-verification              — resend primary-email verification link
//   POST /user/2fa/status                     — current 2FA enrolment state
//   POST /user/2fa/enroll                     — start TOTP enrolment (new secret + backup codes)
//   POST /user/2fa/confirm        {code}      — confirm enrolment with first TOTP code
//   POST /user/2fa/verify         {code}      — in-session step-up (issues _2fa_verified cookie)
//   POST /user/2fa/disable        {code}      — remove 2FA enrolment
//   POST /user/2fa/regenerate-backup-codes {code} — replace backup codes
//   POST /user/email/list                     — list all email addresses for the account
//   POST /user/email/add          {email}     — add a secondary email
//   POST /user/email/remove       {email_hash}— remove a secondary email
//   POST /user/email/promote-primary {email_hash} — promote a verified secondary to primary
//   POST /user/email/send-verification {email_hash} — resend verification for any address

import type { HttpCore } from "./http.js";

// ---- Profile types -------------------------------------------------------

export interface LicenseTier {
  tid: string;
  name: string;
  description?: string | null;
  user_max_apps: number;
  /** Bytes. */
  user_max_total_storage: number;
  /** Bytes per app. */
  app_max_storage: number;
}

/** Full profile as returned by `POST /user/profile`. */
export interface Profile {
  tid: string;
  username: string;
  license_tid: string;
  license?: LicenseTier | null;
  /** Decrypted primary email address. */
  email?: string | null;
  /** Decrypted display name. */
  name?: string | null;
  /** Decrypted mobile number. */
  mobile?: string | null;
  email_verified: boolean;
  /** List of all email addresses (primary + secondaries). */
  emails: UserEmail[];
  /** e.g. `["password"]`, `["google"]`, `["password","google"]`. */
  auth_methods: string[];
  app_count: number;
  /** Bytes used across all apps the user owns. */
  total_used_storage: number;
  /** Epoch-ms. */
  created_at: number;
}

/** One entry from the multi-email list embedded in Profile and `/user/email/list`. */
export interface UserEmail {
  /** Hex-encoded SHA-256 of the canonical address. Use as the key for
   *  remove / promote-primary / send-verification calls. */
  email_hash: string;
  /** Decrypted address. */
  email?: string | null;
  is_primary: boolean;
  verified: boolean;
  /** Epoch-ms. */
  added_at: number;
  /** Epoch-ms, or null when not yet verified. */
  verified_at?: number | null;
}

export interface ProfileUpdateInput {
  /**
   * Pass a non-empty string to set, an empty string to clear, or omit to
   * leave unchanged.
   */
  name?: string;
  mobile?: string;
}

// ---- Password types -------------------------------------------------------

export interface ChangePasswordInput {
  current: string;
  new: string;
  re_new: string;
}

// ---- 2FA types -----------------------------------------------------------

/** Status returned by `POST /user/2fa/status`. */
export interface TwoFaStatus {
  enrolled: boolean;
  /** True only after `/user/2fa/confirm` succeeds. */
  confirmed: boolean;
  /** Epoch-ms, or null when never enrolled. */
  enrolled_at: number | null;
  /** Epoch-ms of last successful TOTP or backup-code use. */
  last_used_at?: number | null;
  /** Unused backup codes remaining. */
  backup_codes_remaining: number;
}

/** Response from `POST /user/2fa/enroll`. */
export interface TwoFaEnrollResult {
  /** `otpauth://` URI — render as a QR code for authenticator apps. */
  provisioning_uri: string;
  /** Raw base32 secret for manual entry. Shown once; never re-fetchable. */
  secret_base32: string;
  /** One-time backup codes. Shown once; never re-fetchable. */
  backup_codes: string[];
  confirmed: false;
}

/** Response from `POST /user/2fa/confirm`. */
export interface TwoFaConfirmResult {
  confirmed: boolean;
}

/** Response from `POST /user/2fa/verify`. */
export interface TwoFaVerifyResult {
  verified: boolean;
  /** Epoch-ms when the `_2fa_verified` cookie expires. */
  valid_until: number;
}

/** Response from `POST /user/2fa/disable`. */
export interface TwoFaDisableResult {
  disabled: boolean;
}

/** Response from `POST /user/2fa/regenerate-backup-codes`. */
export interface TwoFaRegenerateResult {
  /** Fresh backup codes. All previous codes are now invalid. */
  backup_codes: string[];
}

// ---- Email-address management types --------------------------------------

export interface EmailAddInput {
  email: string;
}

export interface EmailByHashInput {
  /** Hex-encoded SHA-256 from `UserEmail.email_hash`. */
  email_hash: string;
}

// ---- Client ---------------------------------------------------------------

export class AccountClient {
  constructor(private readonly http: HttpCore) {}

  // ---- Profile ------------------------------------------------------------

  /**
   * Fetch the extended profile for the authenticated user: decrypted email,
   * name, mobile, license tier, all email addresses, auth methods, storage,
   * and app count.
   */
  async profile(): Promise<Profile> {
    const r = await this.http.post<{ user: Profile }>("/user/profile");
    return r.user;
  }

  /**
   * Update the authenticated user's display name and/or mobile number.
   * Pass `name: ""` or `mobile: ""` to clear the field; omit to leave
   * unchanged.
   */
  updateProfile(input: ProfileUpdateInput): Promise<void> {
    return this.http.post<void>("/user/profile/update", input);
  }

  /**
   * Change the authenticated user's password. Requires the current password.
   * Logs out all other sessions; the calling session gets a refreshed cookie.
   * Throws for Google-only accounts (no `'password'` in `auth_methods`).
   */
  changePassword(input: ChangePasswordInput): Promise<void> {
    return this.http.post<void>("/user/change-password", input);
  }

  /**
   * Give a PASSWORDLESS account (magic-link / OAuth / phone) its first password
   * so it isn't locked to one sign-in method. No old password is required — the
   * active session is the proof — but if the account has a confirmed 2FA
   * enrolment the response is `{ code: "totp_required" }` until you re-call with
   * `{ code }` (a TOTP or backup code). Accounts that already have a password
   * are rejected (`code: "has_password"`); use {@link changePassword} instead.
   */
  setPassword(input: { new: string; re_new?: string; code?: string }): Promise<{
    result: boolean;
    msg?: string;
  }> {
    return this.http.post("/user/set-password", input);
  }

  /**
   * Rename the account's login username. ACL membership is keyed on the stable
   * user id, so permissions are preserved; legacy app-ownership rows are
   * migrated server-side. Other sessions are signed out (their cookies carried
   * the old name); this session's cookie is re-minted.
   */
  changeUsername(newUsername: string): Promise<{ result: boolean; username?: string; msg?: string }> {
    return this.http.post("/user/username/change", { new_username: newUsername });
  }

  /**
   * Connect a Google/Microsoft identity to the CURRENT signed-in account.
   * `credential` is the provider's ID token (GIS credential / MSAL idToken).
   * Linking is email-based: the provider's email must match one of your
   * account's emails, else the response carries `code: "email_mismatch"`.
   */
  linkProvider(provider: "google" | "microsoft", credential: string): Promise<{
    result: boolean;
    msg?: string;
    auth_methods?: string[];
  }> {
    return this.http.post("/user/link", { provider, credential });
  }

  /**
   * Trigger a verification email to the authenticated user's primary email
   * address. Requires Mailler + `TFL5_NOREPLY_FROM` configured. No-op if
   * already verified.
   */
  sendVerification(): Promise<void> {
    return this.http.post<void>("/user/send-verification");
  }

  // ---- 2FA ----------------------------------------------------------------

  /**
   * Return the current 2FA enrolment state: `enrolled`, `confirmed`,
   * `enrolled_at`, `last_used_at`, `backup_codes_remaining`. Never leaks
   * the secret.
   */
  twoFaStatus(): Promise<TwoFaStatus> {
    return this.http.post<TwoFaStatus>("/user/2fa/status");
  }

  /**
   * Start TOTP enrolment. Generates a new secret + 8 backup codes, persists
   * them encrypted, and returns the `otpauth://` provisioning URI (render as
   * QR), the raw base32 secret (manual entry fallback), and the plaintext
   * backup codes.
   *
   * The secret and backup codes are returned **only here** — they are never
   * re-fetchable. The enrolment is not active until `twoFaConfirm` succeeds.
   *
   * Refused with `twofa_already_confirmed` while a confirmed enrolment exists —
   * disable it first. Re-calling before confirming replaces the pending one.
   */
  twoFaEnroll(): Promise<TwoFaEnrollResult> {
    return this.http.post<TwoFaEnrollResult>("/user/2fa/enroll");
  }

  /**
   * Confirm the TOTP enrolment by supplying the first valid 6-digit code
   * from the authenticator app. Stamps `confirmed_at`; the 2FA gate now
   * takes effect for this user.
   */
  twoFaConfirm(code: string): Promise<TwoFaConfirmResult> {
    return this.http.post<TwoFaConfirmResult>("/user/2fa/confirm", { code });
  }

  /**
   * In-session step-up challenge. Accepts a fresh 6-digit TOTP or a
   * one-shot backup code. On success issues the `_2fa_verified` cookie
   * (valid for `twofa_verify_ttl_ms`, default 30 min) that unlocks
   * `/admin/*` when `TFL5_REQUIRE_2FA_FOR_ADMIN` is on.
   */
  twoFaVerify(code: string): Promise<TwoFaVerifyResult> {
    return this.http.post<TwoFaVerifyResult>("/user/2fa/verify", { code });
  }

  /**
   * Disable 2FA. Requires proof-of-possession: a valid TOTP or backup code.
   * Removes the enrolment row and clears the `_2fa_verified` cookie.
   */
  twoFaDisable(code: string): Promise<TwoFaDisableResult> {
    return this.http.post<TwoFaDisableResult>("/user/2fa/disable", { code });
  }

  /**
   * Replace the backup codes. Requires proof-of-possession: a valid TOTP or
   * existing backup code. All previous backup codes are invalidated
   * immediately.
   */
  twoFaRegenerateBackupCodes(code: string): Promise<TwoFaRegenerateResult> {
    return this.http.post<TwoFaRegenerateResult>("/user/2fa/regenerate-backup-codes", { code });
  }

  // ---- Email-address management -------------------------------------------

  /**
   * List all email addresses for the authenticated user (primary + secondaries),
   * sorted primary-first then by `added_at`. Each entry includes `email_hash`
   * (hex SHA-256) for use as the key in remove / promote / send-verification.
   */
  async emailList(): Promise<UserEmail[]> {
    const r = await this.http.post<{ emails: UserEmail[] }>("/user/email/list");
    return r.emails;
  }

  /**
   * Add a secondary email address. Automatically fires a verification email.
   * The row stays unverified until the user clicks the link; promoting an
   * unverified secondary to primary is refused.
   *
   * Returns `{ result, email_hash }`. Throws `validation_email_taken` if the
   * address is already registered on any account.
   */
  emailAdd(input: EmailAddInput): Promise<{ email_hash: string }> {
    return this.http.post<{ email_hash: string }>("/user/email/add", input);
  }

  /**
   * Remove a secondary email. Identified by hex `email_hash` (from
   * `emailList()`). Refuses the primary address — promote another first.
   */
  emailRemove(input: EmailByHashInput): Promise<void> {
    return this.http.post<void>("/user/email/remove", input);
  }

  /**
   * Promote a verified secondary email to primary. The address must be
   * verified first; promoting an unverified one is refused. Updates
   * `users.email_*` so password reset, Google linking, and `/user/profile`
   * all see the new primary address.
   */
  emailPromotePrimary(input: EmailByHashInput): Promise<void> {
    return this.http.post<void>("/user/email/promote-primary", input);
  }

  /**
   * Resend the verification link for any email address the caller owns
   * (primary or secondary). Identified by hex `email_hash`. Refuses
   * already-verified rows.
   */
  emailSendVerification(input: EmailByHashInput): Promise<void> {
    return this.http.post<void>("/user/email/send-verification", input);
  }
}
