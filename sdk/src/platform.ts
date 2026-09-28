// PlatformClient — public, unauthenticated discovery endpoints.

import type { HttpCore } from "./http.js";

/** Public sign-in settings a login page needs before anyone is signed in. */
export interface PlatformInfo {
  test_subdomain_base: string | null;
  google_client_id: string | null;
  google_allowed_origins: string[];
  microsoft_client_id: string | null;
  telegram_bot_username: string | null;
  sso_authority_host: string | null;
  turnstile_enabled: boolean;
  turnstile_site_key: string | null;
}

export interface PlatformVersion {
  service: string;
  cell_id: string;
  git_sha: string | null;
  built_at: string | null;
  version_source: "binary" | "disk" | "none";
}

export class PlatformClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Sign-in settings. Pass `appTid` to get that app's own OAuth client ids
   * when it registered them.
   */
  info(appTid?: string): Promise<PlatformInfo> {
    return this.http.get<PlatformInfo>("/platform/info", { app_tid: appTid });
  }

  /** Build identity of the server answering this request. */
  version(): Promise<PlatformVersion> {
    return this.http.get<PlatformVersion>("/platform/version");
  }
}
