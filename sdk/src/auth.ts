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

export class AuthClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Username/password login. In bearer mode the returned `token` is
   * captured automatically so later calls are authenticated.
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
   */
  google(credential: string, opts: { password?: string } = {}): Promise<LoginResult> {
    return this.capture(this.http.post<LoginResult>("/auth/google", { credential, ...opts }));
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

  /** QR login: start → returns a poll handle the desktop side polls. */
  qrStart(): Promise<{ qr_id?: string; [k: string]: unknown }> {
    return this.http.post("/auth/qr/start");
  }

  /** QR login: poll until the mobile side approves. */
  qrPoll(qrId: string): Promise<LoginResult> {
    return this.capture(this.http.post<LoginResult>("/auth/qr/poll", { qr_id: qrId }));
  }

  private async capture(p: Promise<LoginResult>): Promise<LoginResult> {
    const data = await p;
    if (data?.token) this.http.setToken(data.token);
    return data;
  }
}
