// Authentication surface.
//
// Every sign-in method ends in the same place: the server sets the `_token`
// session cookie. In a browser the cookie is managed for you; in Node the
// SDK keeps it in an in-memory jar (cookie mode is the default). Bearer mode
// is for service tokens (`st_…`) minted for server-to-server integrations —
// `/login` never returns a bearer token.

import type { HttpCore } from "./http.js";

export interface LoginResult {
  result?: boolean;
  /** The signed-in user (password, QR and most alternative logins). */
  user?: { tid: string; username: string };
  /** Only set by flows that mint a bearer token; the SDK captures it. */
  token?: string;
  [k: string]: unknown;
}

/** `/user` — the signed-in user plus public platform settings. */
export interface CurrentUser {
  user: {
    tid: string;
    username: string;
    license_tid: string | null;
    app_count: number;
    groups: Array<{ tid: string; name: string }>;
    app_roles: Record<string, Array<{ tid: string; name: string }>>;
    scope_bindings: unknown;
    [k: string]: unknown;
  };
  platform: {
    test_subdomain_base: string | null;
    google_client_id: string | null;
    microsoft_client_id: string | null;
    telegram_bot_username: string | null;
    [k: string]: unknown;
  };
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

export interface QrStartResult {
  session_id: string;
  /** URL to render as a QR code for the phone to open. */
  approve_url: string;
  expires_at: number;
  ttl_ms: number;
}

export interface QrPollResult {
  status: "pending" | "consumed" | "expired" | "rejected" | (string & {});
  /** Present when `status` is "consumed". */
  user?: { tid: string; username: string };
}

/** The object the Telegram Login Widget hands its callback. */
export interface TelegramWidgetPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface TelegramStatus {
  configured: boolean;
  bot_username: string | null;
  linked: {
    telegram_id: number;
    telegram_username: string | null;
    linked_at: number;
    last_login_at: number | null;
  } | null;
}

export interface VneidStartResult {
  state: string;
  authorize_url: string;
  /** Set when the operator has not configured real VNeID endpoints yet. */
  warning?: string;
}

export class AuthClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Username/password login. Sets the session cookie (kept in the SDK's
   * cookie jar outside a browser) and resolves `{ user: { tid, username } }`.
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

  /**
   * Sign this client out: the server clears the `_token` cookie and the SDK
   * forgets its bearer token. The cookie value is not revoked server-side — a
   * copy stays valid until it expires (24 h from sign-in); change the password
   * to end every session.
   */
  async logout(): Promise<void> {
    await this.http.post("/logout");
    this.http.setToken(undefined);
  }

  /** The signed-in user (`/user`). Throws `UnauthorizedError` when signed out. */
  async me(): Promise<CurrentUser> {
    return this.http.post<CurrentUser>("/user");
  }

  /** Manually set a Bearer token (e.g. one minted out-of-band). */
  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }

  // ---- Data-subject rights (Vietnam Decree 13/2023/ND-CP) ------------

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

  /**
   * Exchange a Microsoft (Azure AD) ID token for a tfl5 session. `credential`
   * is the `idToken` from an MSAL.js `loginPopup`/`ssoSilent` result under the
   * `common` authority. Same account-link semantics as {@link google}: if an
   * existing account owns the email and can't be safely auto-linked, the call
   * throws a `BadRequestError` whose `body.requires_password` is true —
   * re-call with `{ password }` to link.
   */
  microsoft(credential: string, opts: { password?: string } = {}): Promise<LoginResult> {
    return this.capture(this.http.post<LoginResult>("/auth/microsoft", { credential, ...opts }));
  }

  /**
   * Email a one-time sign-in link. Always answers success, whether or not
   * the address has an account (so it cannot be used to probe addresses).
   * `redirectTo` is where the browser lands after the link signs it in.
   */
  magicLink(email: string, opts: { redirectTo?: string } = {}): Promise<unknown> {
    return this.http.post("/auth/email-link", {
      email,
      ...(opts.redirectTo !== undefined ? { redirect_to: opts.redirectTo } : {}),
    });
  }

  /** Start phone OTP (Zalo ZNS). Anti-enumeration: always success-shaped. */
  phoneStart(phone: string, opts: { redirectTo?: string } = {}): Promise<unknown> {
    return this.http.post("/auth/phone/start", {
      phone,
      ...(opts.redirectTo !== undefined ? { redirect_to: opts.redirectTo } : {}),
    });
  }

  /** Complete phone OTP with the code the user received. */
  phoneVerify(phone: string, code: string, opts: { redirectTo?: string } = {}): Promise<LoginResult> {
    return this.capture(
      this.http.post<LoginResult>("/auth/phone/verify", {
        phone,
        code,
        ...(opts.redirectTo !== undefined ? { redirect_to: opts.redirectTo } : {}),
      }),
    );
  }

  // ---- QR login: a signed-in phone approves a desktop sign-in ----------
  //
  //   desktop: qrStart() → show `approve_url` as a QR code → qrPoll() every
  //            ~2s until `status` is "consumed" (session cookie set) or
  //            "expired"/"rejected". Sessions live 5 minutes.
  //   phone:   scans the QR, then qrApprove(session_id) — or qrReject().

  /** Desktop side: open a QR session. */
  qrStart(): Promise<QrStartResult> {
    return this.http.post<QrStartResult>("/auth/qr/start");
  }

  /**
   * Desktop side: poll the QR session. When the phone has approved, the
   * first poll that sees it returns `status: "consumed"` with `user` and
   * sets the session cookie on this client.
   */
  qrPoll(sessionId: string): Promise<QrPollResult> {
    return this.http.post<QrPollResult>("/auth/qr/poll", { session_id: sessionId });
  }

  /** Phone side (must be signed in): approve the desktop sign-in. */
  qrApprove(sessionId: string): Promise<{ approved: true }> {
    return this.http.post("/auth/qr/approve", { session_id: sessionId });
  }

  /** Phone side (no sign-in needed): decline the desktop sign-in. */
  qrReject(sessionId: string): Promise<{ rejected: true }> {
    return this.http.post("/auth/qr/reject", { session_id: sessionId });
  }

  // ---- Telegram (Login Widget) -----------------------------------------
  //
  // Telegram is a second sign-in method bound to an existing account: sign
  // in some other way first, then `telegramLink(payload)` from settings.
  // Afterwards `telegramLogin(payload)` signs that account in. `payload` is
  // the object the Telegram Login Widget passes to its callback, unchanged —
  // the server verifies its signature. The bot is configured on the server;
  // `platform.info().telegram_bot_username` tells the page which bot to load.

  /** Sign in with a Telegram account that was linked earlier. */
  telegramLogin(payload: TelegramWidgetPayload): Promise<{ username: string }> {
    return this.http.post("/auth/telegram/login", payload);
  }

  /** Link a Telegram account to the signed-in user. */
  telegramLink(
    payload: TelegramWidgetPayload,
  ): Promise<{ linked: true; telegram_id: number; telegram_username: string | null }> {
    return this.http.post("/auth/telegram/link", payload);
  }

  /** Remove the signed-in user's Telegram link. */
  telegramUnlink(): Promise<{ unlinked: boolean }> {
    return this.http.post("/auth/telegram/unlink");
  }

  /** Whether Telegram sign-in is configured, and the caller's link if any. */
  telegramStatus(): Promise<TelegramStatus> {
    return this.http.post<TelegramStatus>("/auth/telegram/status");
  }

  // ---- VNeID (Vietnam national e-ID) -----------------------------------

  /**
   * Begin a VNeID sign-in for an app that has the VNeID operator enabled.
   * Navigate the browser to `authorize_url`; VNeID redirects back to the
   * server, which sets the session cookie and sends the browser on to
   * `redirectTo` (a same-site path starting with `/` or `#`). Do not call
   * the callback URL yourself.
   */
  vneidStart(input: { appTid?: string; redirectTo?: string } = {}): Promise<VneidStartResult> {
    return this.http.post<VneidStartResult>("/auth/vneid/start", {
      ...(input.appTid !== undefined ? { app_tid: input.appTid } : {}),
      ...(input.redirectTo !== undefined ? { redirect_to: input.redirectTo } : {}),
    });
  }

  private async capture(p: Promise<LoginResult>): Promise<LoginResult> {
    const data = await p;
    if (data?.token) this.http.setToken(data.token);
    return data;
  }
}
