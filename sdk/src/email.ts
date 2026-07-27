// EmailClient — per-app email inbox, outbound send, and DKIM configuration.
//
// Source of truth: crates/routes/src/email.rs. All outbound mail + DKIM
// crypto happens at the separate `mailler` service; tfl5 holds the per-app
// context (which app owns which domain key, audit logs, inbox) and makes
// thin HTTP calls to mailler for the actual work.
//
// Endpoints:
//   POST /app/email/send          — send a transactional email via mailler (Manager)
//   POST /app/email/sends         — list outbound audit log (Reader)
//   POST /app/email/inbox         — list per-app catch-all inbox (Reader)
//   POST /app/email/mark-read     — mark one or all inbox messages read (Editor)
//   POST /app/email/dkim/create   — mint a DKIM keypair for (app, domain) (Manager)
//   POST /app/email/dkim/list     — list DKIM keys (selector + public DNS) (Reader)
//   POST /app/email/dns-records   — assemble SPF/DKIM/DMARC/MX records (Reader)

import type { HttpCore } from "./http.js";

// ---- Request types -------------------------------------------------------

export interface SendEmailInput {
  /**
   * Local-part of the sender address (no `@`), e.g. `"noreply"`.
   * The server combines it with the first DKIM-configured domain for
   * the app, or with `from_domain` when supplied.
   */
  from_local: string;
  /** Override the sender domain. Falls back to the first DKIM key (by
   *  `created_at ASC`, i.e. the OLDEST configured domain — email.rs:82-96).
   *  Throws `BadRequestError` if neither is available. */
  from_domain?: string;
  /** One or more recipient addresses. At least one required. */
  to: string[];
  subject: string;
  /** HTML body. At least one of `html` or `text` is required. */
  html?: string;
  /** Plaintext body. At least one of `html` or `text` is required. */
  text?: string;
  reply_to?: string;
}

export interface ListSendsInput {
  /** Maximum rows to return (1–500, default 100). */
  limit?: number;
}

export interface ListInboxInput {
  /** Maximum rows to return (1–500, default 100). */
  limit?: number;
}

export interface MarkReadInput {
  /**
   * Specific inbox message tid. Omit to mark ALL unread messages as read.
   */
  email_tid?: string;
}

export interface DkimCreateInput {
  /** Fully-qualified domain, e.g. `"acme.com"`. Must contain a `.` — the
   *  server rejects anything else as `BadRequestError`. */
  domain: string;
}

export interface DnsRecordsInput {
  /** Must already have a DKIM key created for it via {@link
   *  EmailClient.dkimCreate} — the server 400s otherwise. */
  domain: string;
}

// ---- Response types -------------------------------------------------------

/** One row from the outbound send audit log (`/app/email/sends`). */
export interface EmailSendRecord {
  tid: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  body_preview?: string | null;
  provider: string;
  provider_msg_id?: string | null;
  /** `"sent"` or `"failed"`. */
  status: string;
  error?: string | null;
  /** Epoch-ms. */
  sent_at: number;
}

/** One row from the per-app catch-all inbox (`/app/email/inbox`). */
export interface InboxMessage {
  tid: string;
  to_local: string;
  to_domain: string;
  from_addr: string;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  /** Epoch-ms. */
  received_at: number;
  /** Epoch-ms, or null when unread. */
  read_at?: number | null;
}

/**
 * Result of `/app/email/send`. Async/queued mode (the default — see
 * {@link EmailClient.send}) only sets `queued`/`tid`/`from`/`to`
 * (email.rs:129-138); the legacy sync path (`TFL5_QUEUE_SYNC=1`) instead
 * sets `tid`/`from`/`to`/`provider`/`provider_msg_id` with no `queued` field
 * (email.rs:204-214) — check for `queued` to tell which one you got.
 */
export interface SendEmailResult {
  queued?: boolean;
  tid: string;
  from: string;
  to: string[];
  /** Sync path only: provider name. */
  provider?: string;
  /** Sync path only: provider message id. */
  provider_msg_id?: string;
}

/** One DKIM key record from `/app/email/dkim/list`. */
export interface DkimRecord {
  domain: string;
  selector: string;
  /** TXT record value to publish under `<selector>._domainkey.<domain>`. */
  public_dns: string;
  /** Epoch-ms. */
  created_at: number;
}

/** Result of `/app/email/dkim/create`. */
export interface DkimCreateResult {
  domain: string;
  selector: string;
  public_dns: string;
}

/**
 * One DNS record from `/app/email/dns-records`, as assembled by the
 * mailler service (`crates/mailler-client/src/lib.rs:173-181`).
 */
export interface DnsRecord {
  /** Record category (e.g. `"spf"` | `"dkim"` | `"dmarc"` | `"mx"`). Wire
   *  key is `"type"` — the Rust field is named `kind` and serde-renamed. */
  type: string;
  /** Record name/host, e.g. `"@"` or `"selector1._domainkey.acme.com"`. */
  name: string;
  /** DNS record type, e.g. `"TXT"` | `"MX"`. */
  record_type: string;
  value: string;
  /** Human-readable description of what the record is for. */
  purpose: string;
}

export interface MarkReadResult {
  /** Number of messages whose `read_at` was stamped. */
  marked: number;
}

// ---- Client ---------------------------------------------------------------

export class EmailClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Send a transactional email from the app's DKIM-configured domain.
   * Returns queued metadata (async default) or delivery confirmation
   * (sync when the server has `TFL5_QUEUE_SYNC=1`). Requires Manager on
   * the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  send(input: SendEmailInput): Promise<SendEmailResult> {
    return this.http.post<SendEmailResult>("/app/email/send", input);
  }

  /**
   * List the outbound send audit log. Requires Reader on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  listSends(input: ListSendsInput = {}): Promise<EmailSendRecord[]> {
    return this.http.post<EmailSendRecord[]>("/app/email/sends", input);
  }

  /**
   * List the per-app catch-all inbox. Requires Reader on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  inbox(input: ListInboxInput = {}): Promise<InboxMessage[]> {
    return this.http.post<InboxMessage[]>("/app/email/inbox", input);
  }

  /**
   * Mark inbox messages as read. Pass `email_tid` to target one message,
   * or omit to mark all unread messages as read. Requires Editor on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  markRead(input: MarkReadInput = {}): Promise<MarkReadResult> {
    return this.http.post<MarkReadResult>("/app/email/mark-read", input);
  }

  /**
   * Mint a new DKIM keypair for the given domain and persist it to the app.
   * The public DNS value must be published as a TXT record before sending.
   * Upserts on `(app_tid, domain, selector)` — re-creating rotates the key.
   * Requires Manager on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  dkimCreate(input: DkimCreateInput): Promise<DkimCreateResult> {
    return this.http.post<DkimCreateResult>("/app/email/dkim/create", input);
  }

  /**
   * List the DKIM keys registered for the app. Returns selector, domain,
   * and the public DNS value for each key. Requires Reader on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  dkimList(): Promise<DkimRecord[]> {
    return this.http.post<DkimRecord[]>("/app/email/dkim/list", {});
  }

  /**
   * Assemble the full set of SPF, DKIM, DMARC, and MX DNS records needed
   * for the given domain. A DKIM key for the (app, domain) pair must
   * already exist (create one via {@link dkimCreate} first — the server
   * 400s otherwise). Requires Reader on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   *
   * Returns the array of DNS records directly (email.rs:537-542 sends
   * `"data": resp.records` — the handler's `data` field IS the array, not
   * a `{records: [...]}` wrapper). The handler ALSO sends a sibling
   * `"mail_host"` field at the envelope's top level, next to `data` — this
   * SDK's shared transport, `HttpCore.post()`, only returns the unwrapped
   * `data` and has no way to surface that sibling (same limitation as
   * `durable.send()`'s `instance_tid`/`timestamp` — see durable.ts's
   * module-level note). The internal reference SDK's `DnsRecordsResult`
   * type — `{ records: DnsRecord[]; mail_host?: string | null }` — does
   * NOT match what actually comes back through `post()`: calling
   * `.records` on the resolved value would be `undefined`, because the
   * resolved value already IS the array.
   */
  dnsRecords(input: DnsRecordsInput): Promise<DnsRecord[]> {
    return this.http.post<DnsRecord[]>("/app/email/dns-records", input);
  }
}
