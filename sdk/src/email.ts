// EmailClient — per-app email inbox, outbound send, and DKIM configuration.
//
// Endpoints:
//   POST /app/email/send          — send a transactional email via mailler
//   POST /app/email/sends         — list outbound audit log
//   POST /app/email/inbox         — list per-app catch-all inbox
//   POST /app/email/mark-read     — mark one or all inbox messages read
//   POST /app/email/dkim/create   — mint a DKIM keypair for (app, domain)
//   POST /app/email/dkim/list     — list DKIM keys (selector + public DNS)
//   POST /app/email/dns-records   — assemble SPF/DKIM/DMARC/MX records

import type { HttpCore } from "./http.js";

// ---- Request types -------------------------------------------------------

export interface SendEmailInput {
  /**
   * Local-part of the sender address (no `@`), e.g. `"noreply"`.
   * The server combines it with the first DKIM-configured domain for
   * the app, or with `from_domain` when supplied.
   */
  from_local: string;
  /** Override the sender domain. Falls back to the first DKIM key. */
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
  /** Fully-qualified domain, e.g. `"acme.com"`. */
  domain: string;
}

export interface DnsRecordsInput {
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

/** Result of `/app/email/send` (async / queued mode). */
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

/** One DNS record from `/app/email/dns-records`. */
export interface DnsRecord {
  [k: string]: unknown;
}

export interface DnsRecordsResult {
  /** Array of SPF/DKIM/DMARC/MX record objects. */
  records: DnsRecord[];
  mail_host?: string | null;
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
   * (sync when `TFL5_QUEUE_SYNC=1`). Requires Manager on the app.
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
   * Upserts on `(app_tid, domain, selector)`. Requires Manager on the app.
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
   * Assemble the full set of SPF, DKIM, DMARC, and MX DNS records
   * needed for the given domain. A DKIM key for the domain must exist
   * (create via `dkimCreate` first). Requires Reader on the app.
   *
   * `app_tid` is auto-injected via `useApp()`.
   */
  async dnsRecords(input: DnsRecordsInput): Promise<DnsRecordsResult> {
    const env = await this.http.postEnvelope<{ data: DnsRecord[]; mail_host?: string | null }>(
      "/app/email/dns-records",
      input,
    );
    return { records: env.data ?? [], mail_host: env.mail_host ?? null };
  }
}
