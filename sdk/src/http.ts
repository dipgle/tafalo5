// Core transport: builds requests, injects auth + app scope, unwraps the
// `{result,data}` envelope, and throws typed errors. Every *Client class
// is a thin wrapper around this.

import { makeError } from "./errors.js";

export type AuthMode = "cookie" | "bearer";

export interface Tfl5Config {
  /**
   * Base origin, e.g. "https://acme.example.com". In the browser, defaults
   * to `window.location.origin`. The server resolves the tenant from the
   * Host header, which `fetch` derives from this URL.
   */
  host?: string;
  /**
   * Default `app_tid` auto-injected into request bodies that omit it. Set
   * via `tfl5.useApp(appTid)` after you know it, or pass per-call.
   */
  appId?: string;
  /**
   * "cookie" (browser SPA — relies on the `_token` cookie, sends
   * credentials) or "bearer" (Node/CLI — sends `Authorization: Bearer`).
   * Defaults to "cookie" in a browser, "bearer" in Node.
   */
  auth?: AuthMode;
  /** Bearer token for `auth:"bearer"`. Also settable via `setToken()`. */
  token?: string;
  /** Custom fetch (tests / non-standard runtimes). Defaults to global. */
  fetch?: typeof fetch;
}

const hasWindow = typeof window !== "undefined" && typeof window.location !== "undefined";

export class HttpCore {
  host: string;
  appId?: string;
  auth: AuthMode;
  private token?: string;
  private readonly fetchImpl: typeof fetch;
  /**
   * In-memory cookie jar for Node cookie-mode (the browser manages cookies
   * itself and forbids a manual `Cookie` header, so the jar is only used
   * outside a browser). Lets `/login`'s `_token` cookie persist across
   * calls when there's no platform cookie store.
   */
  private readonly jar?: Map<string, string>;

  constructor(cfg: Tfl5Config = {}) {
    this.host = (cfg.host ?? (hasWindow ? window.location.origin : "")).replace(/\/$/, "");
    this.appId = cfg.appId;
    this.auth = cfg.auth ?? (hasWindow ? "cookie" : "bearer");
    this.token = cfg.token;
    if (this.auth === "cookie" && !hasWindow) this.jar = new Map();
    const f = cfg.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new Error(
        "@tfl5/sdk: no global fetch found — pass `fetch` in the config (Node <18).",
      );
    }
    this.fetchImpl = f;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  /**
   * POST a JSON body to `path` and return the unwrapped `data`. When an
   * `appId` is configured it is injected as `app_tid` unless the body
   * already carries one (per-call override wins).
   */
  async post<T = unknown>(path: string, body: object = {}): Promise<T> {
    const b = body as Record<string, unknown>;
    const payload: Record<string, unknown> =
      this.appId && b["app_tid"] === undefined ? { app_tid: this.appId, ...b } : b;
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      credentials: this.auth === "cookie" ? "include" : "same-origin",
    });
    this.captureCookies(res);
    return this.unwrap<T>(res);
  }

  /**
   * POST `multipart/form-data`. Used by the file upload path (the server's
   * `/upload-files`-style middleware persists binaries from the multipart
   * stream — never base64-in-JSON).
   */
  async postForm<T = unknown>(path: string, form: FormData): Promise<T> {
    if (this.appId && !form.has("app_tid")) form.append("app_tid", this.appId);
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers(), // let fetch set the multipart boundary
      body: form,
      credentials: this.auth === "cookie" ? "include" : "same-origin",
    });
    this.captureCookies(res);
    return this.unwrap<T>(res);
  }

  private url(path: string): string {
    return `${this.host}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.auth === "bearer" && this.token) h["Authorization"] = `Bearer ${this.token}`;
    if (this.jar && this.jar.size > 0) {
      h["Cookie"] = Array.from(this.jar, ([k, v]) => `${k}=${v}`).join("; ");
    }
    return h;
  }

  /** Node cookie-mode only: fold any Set-Cookie headers into the jar. */
  private captureCookies(res: Response): void {
    if (!this.jar) return;
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie;
    const raw: string[] = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
    for (const line of raw) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // A cookie cleared by the server (logout) has an empty/expired value;
      // drop it from the jar so we stop sending a dead session.
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private async unwrap<T>(res: Response): Promise<T> {
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body (gateway error page, empty 204, etc.).
      if (res.ok) return undefined as T;
      throw makeError(res.status, { msg: res.statusText }, retryAfter);
    }
    const env = body as {
      result?: boolean;
      data?: T;
      code?: string;
      msg?: string;
      isSignout?: boolean;
    };

    // Success: HTTP 2xx + `result:true`. Return the unwrapped payload.
    if (res.ok && env.result === true) {
      return (env.data !== undefined ? env.data : (body as T)) as T;
    }
    // Some legacy error shapes ship HTTP 200 (not_found, access_denied)
    // with a `code` and no `result:true`. Treat any non-success envelope
    // as an error so callers never confuse rejection with data.
    if (!res.ok || env.code !== undefined || env.isSignout === true || env.result === false) {
      throw makeError(res.status, env, retryAfter);
    }
    // 2xx without the standard envelope (e.g. raw object) — pass through.
    return body as T;
  }
}
