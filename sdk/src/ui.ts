// @tfl5/sdk/ui — OPT-IN browser helpers. Kept out of the headless core
// (`@tfl5/sdk`) on purpose: this module touches the DOM and loads Google's
// third-party GIS script, neither of which belongs in the Node/CLI client or
// its bundle budget. Import it only from browser code:
//
//   import { TFL5 } from "@tfl5/sdk";          // or "/sdk.mjs" when served
//   import { mountGoogleButton } from "@tfl5/sdk/ui";  // or "/sdk-ui.mjs"
//
// The helper wraps the exact flow the admin UI uses: fetch the operator's
// `google_client_id`, load GIS, render its button, exchange the credential
// via `tfl5.auth.google(...)`, and — if the email collides with an existing
// unverified account — drive the password-link prompt.

import type { LoginResult } from "./auth.js";

/** Minimal structural view of the client this helper needs. Accepts a full
 *  {@link TFL5} instance; typed structurally so `@tfl5/sdk/ui` stays
 *  decoupled from the core class (no runtime import of the barrel). */
export interface GoogleAuthCapable {
  auth: {
    google(credential: string, opts?: { password?: string }): Promise<LoginResult>;
  };
  /**
   * Scope the client to a specific app. Present on a full {@link TFL5}
   * instance; the helper checks for it at runtime so callers that pass a
   * narrower object are still accepted.
   */
  useApp?(appTid: string): unknown;
}

export interface MountGoogleButtonOptions {
  /** Element (or CSS selector) to render Google's button into. */
  target: HTMLElement | string;
  /** Called once the session is established on the client. */
  onSignIn: (result: LoginResult) => void;
  /**
   * OAuth client id. Omit to auto-fetch it from `GET {host}/platform/info`
   * (`google_client_id`) — the same source the admin UI reads.
   */
  clientId?: string;
  /**
   * Platform origin for `/platform/info` and (implicitly) the same-origin
   * cookie the sign-in sets. Defaults to `window.location.origin`, which is
   * correct whenever the page is served by the tfl5 platform itself.
   */
  host?: string;
  /**
   * Invoked when the email matches an existing *unverified* account and the
   * server needs its password to link (see {@link GoogleAuthCapable} /
   * `tfl5.auth.google`). Return the password to link, or a falsy value to
   * abort silently. If omitted, the link refusal surfaces via `onError`.
   */
  onRequiresPassword?: (
    usernameHint: string | undefined,
    msg: string | undefined,
  ) => Promise<string | null | undefined> | string | null | undefined;
  /** Called on any failure (script load, config, exchange). */
  onError?: (err: unknown) => void;
  /**
   * Passed straight to `google.accounts.id.renderButton`. Defaults to a
   * large "Continue with Google" filled button.
   * @see https://developers.google.com/identity/gsi/web/reference/js-reference#GsiButtonConfiguration
   */
  buttonConfig?: Record<string, unknown>;
  /**
   * Scope the button to a specific app (community-platform model). When set:
   * (a) the helper fetches THAT app's `google_client_id` from
   *     `GET /platform/info?app_tid=<appId>` so each app can have its own
   *     OAuth client; and (b) `tfl5.useApp(appId)` is called (if available)
   *     so the subsequent `/auth/google` exchange carries `app_tid` and the
   *     server verifies the credential against the app's own OAuth client.
   */
  appId?: string;
}

/** Handle returned by {@link mountGoogleButton}. */
export interface GoogleButtonHandle {
  /** The client id that was actually used (resolved from config or fetched). */
  clientId: string;
}

// Minimal ambient shape of the slice of Google Identity Services we call.
interface GisId {
  initialize(config: {
    client_id: string;
    callback: (resp: { credential?: string }) => void;
    use_fedcm_for_prompt?: boolean;
    [k: string]: unknown;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
}
type GisWindow = typeof globalThis & {
  google?: { accounts?: { id?: GisId } };
};

const GIS_SRC = "https://accounts.google.com/gsi/client";
let _gisScriptPromise: Promise<void> | null = null;

/** Load the GIS client script once; subsequent calls share the promise. */
export function loadGisScript(): Promise<void> {
  if (_gisScriptPromise) return _gisScriptPromise;
  _gisScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      if ((existing as unknown as { dataset?: { gisLoaded?: string } }).dataset?.gisLoaded) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("GIS script failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("GIS script failed to load"));
    document.head.appendChild(s);
  });
  return _gisScriptPromise;
}

function resolveTarget(target: HTMLElement | string): HTMLElement {
  const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!el) throw new Error(`@tfl5/sdk/ui: target element not found (${String(target)})`);
  return el;
}

/**
 * Render a "Continue with Google" button and wire it to `tfl5.auth.google`.
 * Resolves once the button is mounted (sign-in happens later, asynchronously,
 * via the callbacks). Rejects if the client id can't be resolved or GIS fails
 * to load.
 */
export async function mountGoogleButton(
  tfl5: GoogleAuthCapable,
  options: MountGoogleButtonOptions,
): Promise<GoogleButtonHandle> {
  const el = resolveTarget(options.target);
  const host = (options.host ?? window.location.origin).replace(/\/$/, "");

  // Scope the client to the target app so auth.google carries app_tid.
  if (options.appId && typeof tfl5.useApp === "function") {
    tfl5.useApp(options.appId);
  }

  let clientId = options.clientId;
  if (!clientId) {
    // When appId is set, fetch the APP's own google_client_id via ?app_tid=.
    const infoUrl = options.appId
      ? `${host}/platform/info?app_tid=${encodeURIComponent(options.appId)}`
      : `${host}/platform/info`;
    const info = await fetch(infoUrl)
      .then((r) => r.json() as Promise<{ google_client_id?: string }>)
      .catch(() => ({}) as { google_client_id?: string });
    clientId = info.google_client_id;
  }
  if (!clientId) {
    throw new Error(
      "@tfl5/sdk/ui: no google_client_id — pass { clientId } or have the " +
        "operator set TFL5_GOOGLE_CLIENT_ID.",
    );
  }

  await loadGisScript();
  const gid = (window as GisWindow).google?.accounts?.id;
  if (!gid) throw new Error("@tfl5/sdk/ui: Google Identity Services unavailable after load");

  gid.initialize({
    client_id: clientId,
    // The explicit button is enough; don't let One Tap steal focus.
    use_fedcm_for_prompt: false,
    callback: (resp) => {
      void handleCredential(tfl5, resp, options);
    },
  });
  gid.renderButton(
    el,
    options.buttonConfig ?? {
      theme: "filled_black",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
    },
  );

  return { clientId };
}

async function handleCredential(
  tfl5: GoogleAuthCapable,
  resp: { credential?: string },
  options: MountGoogleButtonOptions,
): Promise<void> {
  try {
    const credential = resp?.credential;
    if (!credential) throw new Error("Google sign-in cancelled");

    let result: LoginResult;
    try {
      result = await tfl5.auth.google(credential);
    } catch (err) {
      // `tfl5.auth.google` throws a BadRequestError when the email hits an
      // existing unverified account; its `body.requires_password` asks for a
      // password to link. Detected structurally so this helper needn't import
      // the error class at runtime.
      const body = (err as { body?: { requires_password?: boolean; username_hint?: string; msg?: string } })?.body;
      if (body?.requires_password && options.onRequiresPassword) {
        const pw = await options.onRequiresPassword(body.username_hint, body.msg);
        if (!pw) return; // user aborted the link
        result = await tfl5.auth.google(credential, { password: pw });
      } else {
        throw err;
      }
    }
    options.onSignIn(result);
  } catch (err) {
    if (options.onError) options.onError(err);
    else console.error("@tfl5/sdk/ui: Google sign-in failed", err);
  }
}
