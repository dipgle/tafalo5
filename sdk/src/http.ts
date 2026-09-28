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
   * "cookie" — the session lives in the `_token` cookie that `/login` sets.
   * In a browser the SDK sends `credentials: "include"`; outside a browser
   * it keeps an in-memory cookie jar so a Node process can log in with a
   * username and password.
   *
   * "bearer" — sends `Authorization: Bearer <token>`. Use it with a
   * service token (`st_…`) minted for a server-to-server integration;
   * `/login` does not return a bearer token.
   *
   * Default: "bearer" when `token` is set, otherwise "cookie".
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
    this.auth = cfg.auth ?? (cfg.token ? "bearer" : "cookie");
    this.token = cfg.token;
    if (this.auth === "cookie" && !hasWindow) this.jar = new Map();
    const f = cfg.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new Error(
        "@tfl5/sdk: no global fetch found — pass `fetch` in the config (Node <18).",
      );
    }
    // Call through a plain function: browsers refuse `fetch` invoked as a
    // method of another object ("Illegal invocation"), which is what
    // `this.fetchImpl(...)` would otherwise do.
    this.fetchImpl = (input, init) => f(input, init);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  /**
   * The session credentials this client would send (Cookie from the Node
   * cookie jar, or the bearer Authorization header). For transports the SDK
   * does not issue through `fetch`, such as a WebSocket handshake in Node.
   */
  authHeaders(): Record<string, string> {
    return this.headers();
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
   * Like `post`, but on success return the whole envelope instead of `data`.
   * For endpoints that put useful fields beside `data` (`next_cursor`,
   * `warnings`, `limit`). Errors are thrown exactly as `post` throws them.
   */
  async postEnvelope<E = Record<string, unknown>>(path: string, body: object = {}): Promise<E> {
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
    return this.unwrap<E>(res, true);
  }

  /**
   * POST a JSON body and return the **full parsed response body** without
   * unwrapping the `{result, data}` envelope. Use only when the caller needs
   * fields at the envelope level (e.g. `instance_tid`, `timestamp`) that
   * `post<T>` discards during unwrap. Auth injection + cookie handling are
   * identical to `post`. Throws `Tfl5Error` on network or parse failures but
   * does NOT throw on `result:false` — the caller is responsible for
   * interpreting the body.
   */
  async postFull<T = unknown>(path: string, body: object = {}): Promise<T> {
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
    // For non-2xx we still want typed errors (gateway errors, 5xx, etc.).
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      let errBody: unknown;
      try {
        errBody = await res.json();
      } catch {
        throw makeError(res.status, { msg: res.statusText }, retryAfter);
      }
      throw makeError(res.status, errBody as { code?: string; msg?: string }, retryAfter);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return undefined as T;
    }
    return parsed as T;
  }

  /** `postForm`, but resolves the whole envelope (for `warnings` beside `data`). */
  async postFormEnvelope<E = Record<string, unknown>>(path: string, form: FormData): Promise<E> {
    if (this.appId && !form.has("app_tid")) form.append("app_tid", this.appId);
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers(),
      body: form,
      credentials: this.auth === "cookie" ? "include" : "same-origin",
    });
    this.captureCookies(res);
    return this.unwrap<E>(res, true);
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

  /**
   * GET `path` with optional query parameters. Unwraps the `{result,data}`
   * envelope when the server sends one; endpoints that answer a bare JSON
   * object (e.g. `/platform/info`) are returned as-is.
   */
  async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const res = await this.fetchImpl(this.urlFor(path, query), {
      method: "GET",
      headers: this.headers(),
      credentials: this.auth === "cookie" ? "include" : "same-origin",
    });
    this.captureCookies(res);
    return this.unwrap<T>(res);
  }

  /**
   * POST a JSON body to an endpoint that answers raw bytes on success
   * (a PDF, a file download). Errors still arrive as the JSON envelope and
   * are thrown as `Tfl5Error`.
   */
  async postBlob(path: string, body: object = {}): Promise<Blob> {
    return (await this.postBlobNamed(path, body)).blob;
  }

  /**
   * Like `postBlob`, plus the filename from `Content-Disposition` when the
   * server sends one. (A browser can only read that header on the same
   * origin as the API.)
   */
  async postBlobNamed(
    path: string,
    body: object = {},
  ): Promise<{ blob: Blob; filename?: string; mimeType?: string }> {
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
    const type = res.headers.get("content-type") ?? "";
    const disposition = res.headers.get("content-disposition");
    // Success is marked by Content-Disposition (always set on a download), so
    // a stored JSON file is not mistaken for an error envelope.
    if (res.ok && (disposition !== null || !type.includes("application/json"))) {
      return { blob: await res.blob(), filename: parseFilename(disposition), mimeType: type || undefined };
    }
    await this.unwrap<unknown>(res);
    throw makeError(res.status, { code: "bad_request", msg: "expected a binary response" });
  }

  /**
   * Absolute URL for `path` on this host, with query parameters. Use it for
   * endpoints a browser loads directly (an `<iframe src>`, a download link).
   */
  urlFor(path: string, query: Record<string, string | number | undefined> = {}): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return s ? `${this.url(path)}?${s}` : this.url(path);
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

  private async unwrap<T>(res: Response, whole = false): Promise<T> {
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

    // A missing/expired session is sometimes answered HTTP 200
    // `{isSignout:true, result:true}` — check it BEFORE the success branch,
    // or a signed-out caller would receive the envelope as if it were data.
    if (env.isSignout === true) {
      throw makeError(401, { ...env, code: env.code ?? "unauthorized" }, retryAfter);
    }
    // Success: HTTP 2xx + `result:true`. Return the unwrapped payload.
    if (res.ok && env.result === true) {
      if (whole) return body as T;
      return (env.data !== undefined ? env.data : (body as T)) as T;
    }
    // Some legacy error shapes ship HTTP 200 (not_found, access_denied)
    // with a `code` and no `result:true`. Treat any non-success envelope
    // as an error so callers never confuse rejection with data.
    if (!res.ok || env.code !== undefined || env.result === false) {
      throw makeError(res.status, env, retryAfter);
    }
    // 2xx without the standard envelope (e.g. raw object) — pass through.
    return body as T;
  }
}

/** Filename from a Content-Disposition header (`filename*=UTF-8''…` wins). */
function parseFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  const v = plain?.[1] ?? plain?.[2];
  return v ? v.trim() : undefined;
}
