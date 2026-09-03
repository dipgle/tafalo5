// Authentication surface. Two modes share one client:
//   - cookie (browser): /login sets the `_token` cookie; nothing to store.
//   - bearer (Node/CLI): /login (or a minted service token) returns a
//     `token` the SDK stashes on the transport for subsequent calls.

import type { HttpCore } from "./http.js";

export interface LoginResult {
  /** Present in bearer/server responses; absent in pure cookie flows. */
  token?: string;
  user_tid?: string;
  [k: string]: unknown;
}

/** Result of {@link AuthClient.exportData} — the caller's own data (PDPD
 *  right to access / portability), already unwrapped from the `{result,data}`
 *  envelope. Email *addresses* are not included; fetch them via
 *  `POST /user/email/list`. */
export interface DataExport {
  exported_at: number;
  regulation: string;
  account: Record<string, unknown>;
  emails: unknown[];
  app_memberships: unknown[];
  [k: string]: unknown;
}

/** Success result of {@link AuthClient.eraseAccount} / {@link
 *  AuthClient.cancelErase}. Refusals do NOT come back here — they throw a
 *  {@link Tfl5Error} carrying the `.code` (see each method's docs). */
export interface EraseResult {
  result: boolean;
  /** On a scheduled erasure: epoch-ms when the grace window ends (the hard
   *  erase runs after this unless cancelled). */
  erase_after?: number;
  erase_requested_at?: number;
  msg?: string;
  [k: string]: unknown;
}

/**
 * Every state {@link AuthClient.qrPoll} can report. The envelope's
 * `result` is `true` for ALL of these — including `"expired"` and
 * `"rejected"` — so the promise never rejects while you're merely
 * polling; check `.status` on every resolved poll instead of relying on
 * a throw to tell you when to stop.
 *
 * `"approved"` is never actually observable here: the instant a poll sees
 * it server-side, that same request atomically flips it to `"consumed"`
 * (or throws, on a lost race against a concurrent poll) — it exists only
 * as a transient DB state between the phone's approve and the next poll.
 */
export type QrStatus = "pending" | "expired" | "rejected" | "consumed";

/** Response from {@link AuthClient.qrPoll}. */
export interface QrPollResult extends LoginResult {
  status?: QrStatus;
  /** Present only when `status === "consumed"` — the account that just
   *  signed in via this poll. (Cookie-mode only: unlike other login
   *  methods, QR never mints a bearer `token` here — the session cookie
   *  is set directly on the poll response.) */
  user?: { tid: string; username: string };
}

export class AuthClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Username/password login. In bearer mode the returned `token` is
   * captured automatically so later calls are authenticated.
   *
   * `username` is folded the same way `/reg` stores it (lower-cased,
   * diacritics stripped, spaces → underscores) if the exact string you
   * pass doesn't match any account — so a user who registered as "Alice"
   * signs in fine typing "Alice", "alice", or "álice". The raw string is
   * still tried FIRST and wins any tie, so accounts from before this
   * folding existed keep working unchanged. Stop maintaining your own
   * case-normalization on top of this call; the server already does it.
   */
  async login(username: string, password: string): Promise<LoginResult> {
    const data = await this.http.post<LoginResult>("/login", { username, password });
    if (data?.token) this.http.setToken(data.token);
    return data;
  }

  /** Register a new user. */
  async register(input: Record<string, unknown>): Promise<unknown> {
    return this.http.post("/reg", input);
  }

  /** Invalidate the current session (clears cookie / server session). */
  async logout(): Promise<void> {
    await this.http.post("/logout");
    this.http.setToken(undefined);
  }

  /** Current authenticated user (`/user`). Throws Unauthorized if none. */
  async me(): Promise<unknown> {
    return this.http.post("/user");
  }

  /** Manually set a Bearer token (e.g. one minted out-of-band). */
  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }

  // ---- PDPD (NĐ 13/2023) — data-subject rights ------------------------

  /**
   * Export the caller's own account: profile + email metadata + app
   * memberships (right to access / data portability). Self-scoped — there
   * is no admin-override form. Plaintext email addresses are fetched
   * separately via `POST /user/email/list`; documents/files inside each app
   * are exported through that app's own `/app/doc/*` and `/app/file/*` APIs.
   */
  exportData(): Promise<DataExport> {
    return this.http.post<DataExport>("/user/data/export");
  }

  /**
   * Request erasure of the caller's own account (right to be forgotten).
   * On success stamps the request, signs the caller out on every device
   * (treat yourself as logged out afterwards), and returns the schedule
   * (`{ result, erase_after, ... }`); the hard erase runs in the background
   * after a grace window (default 24h) during which {@link cancelErase}
   * can withdraw it.
   *
   * Pass `password` for password accounts, or a TOTP/backup `code` for
   * passwordless accounts that have 2FA enrolled.
   *
   * REFUSALS THROW a {@link Tfl5Error} — catch it and branch on `.code`:
   * `'owns_apps'` (the caller still owns apps — `err.body.app_tids` lists
   * them; transfer or delete first), `'password_required'`, or
   * `'totp_required'`.
   */
  eraseAccount(confirm: { password?: string; code?: string } = {}): Promise<EraseResult> {
    return this.http.post<EraseResult>("/user/data/erase", confirm);
  }

  /**
   * Withdraw a pending erasure request (only valid inside the grace window,
   * on a fresh login). THROWS a {@link Tfl5Error} with
   * `code:'no_pending_erasure'` if there is nothing to cancel.
   */
  cancelErase(): Promise<EraseResult> {
    return this.http.post<EraseResult>("/user/data/erase/cancel");
  }

  // ---- Alternative login methods (all converge on a session) ----------

  /**
   * Google Identity Services sign-in. Pass the JWT string GIS hands your
   * callback — `response.credential` (the field is literally named
   * `credential`; it is *not* an OAuth `id_token` query param). On a fresh
   * email or an already-verified account this establishes the session and
   * resolves the {@link LoginResult}.
   *
   * LINK REFUSAL: if an *unverified* local account already owns this email,
   * the server won't merge identities blindly — it throws a
   * {@link BadRequestError} whose `body.requires_password === true` (and
   * `body.username_hint` names the account). Catch it, collect that
   * account's password, and call again with `{ password }` to prove
   * ownership + link + sign in:
   *
   * ```ts
   * try {
   *   await tfl5.auth.google(credential);
   * } catch (e) {
   *   if (e instanceof BadRequestError && e.body?.requires_password) {
   *     const pw = await promptForPassword(e.body.username_hint);
   *     await tfl5.auth.google(credential, { password: pw });
   *   } else throw e;
   * }
   * ```
   *
   * Browsers can skip all of this and use `mountGoogleButton` from
   * `@tfl5/sdk/ui`, which renders the Google button and drives this flow
   * (including the link prompt) for you.
   *
   * ORIGIN TRAP — a rendered button is not a working button. `GET
   * /platform/info` also carries `google_allowed_origins: string[]`: the
   * operator's `TFL5_GOOGLE_ALLOWED_ORIGINS`, i.e. the Authorized
   * JavaScript origins actually registered on the Google OAuth client.
   * `google_client_id` only says the provider is turned on — it says
   * nothing about whether *this page's origin* is one Google will accept.
   * A host outside that list renders the button fine and then 403s from
   * `accounts.google.com/gsi/button` the instant it's clicked, with no
   * error surfaced to `google()` (the click never reaches this endpoint).
   * The case that hurts most: the platform's own multi-tenant test
   * subdomain `<app_tid>.test.<base>` is a fresh, unregisterable origin
   * for every app, so it 403s by construction unless the operator has
   * deliberately widened the allowlist for it. Check the caller's origin
   * against `google_allowed_origins` (empty array = operator hasn't
   * declared the list, i.e. no extra restriction) BEFORE rendering the
   * button, not after the click fails.
   */
  google(credential: string, opts: { password?: string } = {}): Promise<LoginResult> {
    return this.capture(this.http.post<LoginResult>("/auth/google", { credential, ...opts }));
  }

  /**
   * Microsoft (Azure AD / MSAL) sign-in. Pass the ID token JWT MSAL hands
   * back from `loginPopup`/`ssoSilent` under the `common` authority (any
   * work/school OR personal Microsoft account, incl. @outlook/@hotmail) —
   * the body field is still named `credential`, same as {@link google}.
   *
   * ACCOUNT-LINK POLICY DIFFERS FROM GOOGLE. Microsoft v2 ID tokens often
   * omit `email_verified`, and a personal account's `email` claim can be
   * user-set, so the server won't treat "same email" as proof of identity
   * as readily as it does for Google:
   * - No existing account with this email → a new account is created,
   *   marked verified only if the email itself was trusted (org-directory,
   *   or a personal account with the token's `xms_edov === true`).
   * - An existing VERIFIED account whose email IS trusted → auto-linked
   *   and signed in, same as {@link google}.
   * - Every other match — an existing UNVERIFIED account, or a verified
   *   one whose Microsoft email ISN'T trusted — falls back to the same
   *   password-proof gate as {@link google}: it resolves with
   *   `requires_password: true` and `username_hint` naming the account.
   *   Catch it and re-call with `{ password }` to prove ownership + link +
   *   sign in:
   *
   * ```ts
   * try {
   *   await tfl5.auth.microsoft(idToken);
   * } catch (e) {
   *   if (e instanceof BadRequestError && e.body?.requires_password) {
   *     const pw = await promptForPassword(e.body.username_hint);
   *     await tfl5.auth.microsoft(idToken, { password: pw });
   *   } else throw e;
   * }
   * ```
   */
  microsoft(credential: string, opts: { password?: string } = {}): Promise<LoginResult> {
    return this.capture(this.http.post<LoginResult>("/auth/microsoft", { credential, ...opts }));
  }

  /** Send a magic email link (anti-enumeration: always success-shaped). */
  magicLink(email: string): Promise<unknown> {
    return this.http.post("/auth/email-link", { email });
  }

  /** Start phone OTP (Zalo ZNS). Anti-enumeration: always success-shaped. */
  phoneStart(phone: string): Promise<unknown> {
    return this.http.post("/auth/phone/start", { phone });
  }

  /** Complete phone OTP. */
  phoneVerify(phone: string, otp: string): Promise<LoginResult> {
    return this.capture(this.http.post<LoginResult>("/auth/phone/verify", { phone, otp }));
  }

  /**
   * QR login: start → mints a session the desktop side polls and the
   * mobile side scans/approves.
   *
   * BUG FIX: this used to type the response as `{ qr_id?: string }` and
   * {@link qrPoll} sent `{ qr_id }` on every call — but the server's field
   * is, and has only ever been, `session_id` (verified against
   * `crates/routes/src/auth_qr.rs`'s `PollInput`/`ApproveInput`/
   * `RejectInput`; there is no `qr_id` alias). The old `qrPoll` body was
   * therefore missing its one required field on every request, so QR
   * login could never actually complete through this method. Fixed here
   * — the resolved `session_id` is what you pass straight into
   * {@link qrPoll} / {@link qrReject}.
   */
  qrStart(): Promise<{
    session_id?: string;
    /** Full URL to render as the QR code; the phone opens this. */
    approve_url?: string;
    /** Epoch-ms when this session stops accepting `approve`/`reject`/`poll`. */
    expires_at?: number;
    ttl_ms?: number;
    [k: string]: unknown;
  }> {
    return this.http.post("/auth/qr/start");
  }

  /**
   * QR login: poll until the mobile side approves. Resolves on every call
   * — see {@link QrStatus} for why a resolved promise does not by itself
   * mean "signed in": read `.status` and keep polling while it's
   * `"pending"`; stop on `"expired"` / `"rejected"` (retry with a fresh
   * {@link qrStart}); `"consumed"` is the terminal success.
   */
  qrPoll(qrId: string): Promise<QrPollResult> {
    return this.capture(
      this.http.post<QrPollResult>("/auth/qr/poll", { session_id: qrId }),
    );
  }

  /**
   * QR login: the phone taps "Cancel" on a `pending` session it scanned.
   * Deliberately UNAUTHENTICATED — the phone that scans a QR code usually
   * hasn't signed in yet, so the only proof this endpoint demands is
   * possession of the 256-bit `qrId` itself (the same secret that already
   * gates the strictly more powerful {@link qrPoll}, which mints a
   * session). It is also only reachable from `"pending"`: a session the
   * mobile side already approved is not revocable through this call, so a
   * Cancel that races in after an Approve can never undo a session that
   * was already handed to the desktop.
   *
   * Resolves `{ rejected: true }` on success. On an unknown / expired /
   * already-approved session it throws (no `.code`, message only) rather
   * than resolving `{ rejected: false }` — the server deliberately
   * collapses those three outcomes into one opaque message so this
   * endpoint can't be used to probe which `qrId`s exist.
   */
  qrReject(qrId: string): Promise<{ rejected: boolean }> {
    return this.http.post<{ rejected: boolean }>("/auth/qr/reject", { session_id: qrId });
  }

  private async capture<T extends LoginResult>(p: Promise<T>): Promise<T> {
    const data = await p;
    if (data?.token) this.http.setToken(data.token);
    return data;
  }
}
