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
//
// DKIM IS A PRECONDITION OF SENDING, NOT A NICETY. `send` refuses any mail
// the platform could not sign: the domain it resolves — explicit
// `from_domain` or the app's oldest key — must have a DKIM key registered
// for THIS app. Provision order for a new app is therefore
// `dkimCreate(domain)` → publish `dnsRecords(domain)` → `send(...)`.
// See {@link EMAIL_DKIM_NOT_CONFIGURED} and {@link EMAIL_INVALID_RECIPIENT}
// for the two coded refusals `send` raises.

import type { HttpCore } from "./http.js";

// ---- Stable error codes --------------------------------------------------
//
// Both refusals below are 400s raised by `/app/email/send` BEFORE anything
// is queued, so nothing was sent when you see them. Switch on these
// constants rather than on `msg`, which the server may reword or localize.

/**
 * `/app/email/send`: no DKIM key exists for the (app, domain) pair the
 * send would have used — either the explicit `from_domain`, or the app's
 * oldest key when `from_domain` was omitted and there is none. Mint one
 * with {@link EmailClient.dkimCreate} (then publish the DNS records) and
 * retry; retrying without that changes nothing.
 */
export const EMAIL_DKIM_NOT_CONFIGURED = "email_dkim_not_configured" as const;

/**
 * `/app/email/send`: one of `to` is not a plausible address. The server's
 * rule (shared with the user-email fields, so it cannot drift between two
 * regexes): trimmed, non-empty, ≤254 chars, no whitespace, exactly one
 * `@`, non-empty local part, and a domain of ≥2 non-empty dot-separated
 * labels. Deliberately NOT full RFC 5322. `msg` names the offending value.
 */
export const EMAIL_INVALID_RECIPIENT = "email_invalid_recipient" as const;

// ---- Request types -------------------------------------------------------

export interface SendEmailInput {
  /**
   * Local-part of the sender address (no `@`), e.g. `"noreply"`.
   * The server combines it with the first DKIM-configured domain for
   * the app, or with `from_domain` when supplied.
   */
  from_local: string;
  /**
   * Sender domain. NOT a free-text override: whatever you pass must have a
   * DKIM key registered for THIS app AND THAT domain, or the send is
   * refused with `BadRequestError`, `code: "email_dkim_not_configured"`
   * (`EMAIL_DKIM_NOT_CONFIGURED`). Passing a domain the app has no key for
   * used to be accepted and answered `{result:true, queued:true}` for mail
   * the platform could never sign — the refusal is the fix, not a
   * regression.
   *
   * Matched case-insensitively and trimmed, so `" ACME.com "` finds the
   * key stored as `acme.com`.
   *
   * Omit it and the server falls back to the app's OLDEST DKIM key (by
   * `created_at ASC`). That branch is refused with the SAME code when the
   * app has no DKIM key at all — so `email_dkim_not_configured` means
   * "create a key first" in both directions; use {@link
   * EmailClient.dkimList} to see which domains actually exist.
   */
  from_domain?: string;
  /**
   * One or more recipient addresses. At least one required, and each is
   * shape-validated server-side — a bare `"not-an-email"` is refused with
   * `BadRequestError`, `code: "email_invalid_recipient"`
   * (`EMAIL_INVALID_RECIPIENT`), and the offending value is named back in
   * `msg` (it is the caller's own input, not a secret). Previously such a
   * value was accepted and queued for delivery.
   *
   * The check is plausibility, not deliverability: it rejects malformed
   * strings, it does not prove the mailbox exists. Validate in your form
   * too — this is the trust boundary, not the UX.
   */
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
 * {@link EmailClient.send}) only sets `queued`/`tid`/`from`/`to`; the
 * legacy sync path (`TFL5_QUEUE_SYNC=1`) instead sets
 * `tid`/`from`/`to`/`provider`/`provider_msg_id` with no `queued` field —
 * check for `queued` to tell which one you got. `from` is the address the
 * server actually used, i.e. `from_local@<resolved DKIM domain>`.
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
   * Send a transactional email from a DKIM-configured domain of the app.
   * Returns queued metadata (async default) or delivery confirmation
   * (sync when the server has `TFL5_QUEUE_SYNC=1`). Requires Manager on
   * the app.
   *
   * VALIDATED BEFORE QUEUEING, in this order — every one of these throws
   * `BadRequestError` and nothing is sent:
   *   1. mailler not configured on the deployment (no `code`);
   *   2. no DKIM key for the (app, domain) pair →
   *      {@link EMAIL_DKIM_NOT_CONFIGURED}. Both the explicit
   *      `from_domain` and the omitted-domain fallback go through this;
   *   3. `from_local` empty or containing `@` (no `code`);
   *   4. `to` empty (no `code`), then any implausible recipient →
   *      {@link EMAIL_INVALID_RECIPIENT};
   *   5. neither `html` nor `text` (no `code`).
   * The two coded refusals are the ones worth branching on in a UI; the
   * order matters because a request wrong in two ways reports the first.
   *
   * A `{queued: true}` answer therefore means the platform accepted mail
   * it can actually sign — which was not true before these checks existed.
   * It still does not mean the recipient's server accepted it: delivery
   * outcome shows up in {@link listSends} as `status`.
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
   * Returns the array of DNS records directly (the handler sends
   * `"data": resp.records`, so `data` IS the array — not a
   * `{records: [...]}` wrapper). The internal reference SDK's
   * `DnsRecordsResult` type — `{ records: DnsRecord[]; mail_host?: string
   * | null }` — does NOT match what comes back through `post()`: reading
   * `.records` off the resolved value gives `undefined`, because the
   * resolved value already IS the array.
   *
   * The handler ALSO sends a sibling `"mail_host"` at the envelope's top
   * level, next to `data`, which `post()` discards. That is a choice, not
   * a transport limitation: `HttpCore.postFull()` exists and returns the
   * whole envelope (`durable.send()` and `billing.invoiceIssue()` use it).
   * This method keeps the array return because the records are what a
   * caller publishes; if you need `mail_host`, call `postFull()` on your
   * own `HttpCore` (exported from the package root) against the same path.
   */
  dnsRecords(input: DnsRecordsInput): Promise<DnsRecord[]> {
    return this.http.post<DnsRecord[]>("/app/email/dns-records", input);
  }
}
