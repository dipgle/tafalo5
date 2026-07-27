// ChatClient — per-app chat: REST scrollback (`/app/chat/history`) plus a
// thin wrapper around the live WebSocket (`/ws/chat`,
// crates/routes/src/ws_chat.rs).
//
// THE CORE PATTERN (verified in ws_chat.rs's `handle_socket` — it never
// queries `chat_message` on connect, it only subscribes to the room's live
// broadcast bus then sends a `welcome` frame): `history()` is the SOLE
// backfill mechanism. The socket only ever delivers messages sent AFTER its
// subscription starts — there is no server-side replay. A naive "socket
// appends onto history" merge can therefore see the SAME message twice (a
// message landing in the narrow window between the socket's subscribe and
// a REST fetch) — when you splice live frames onto a history list, DEDUPE
// BY `tid`, don't assume the two streams are disjoint.
//
// ADMIN/MODERATION endpoints on this surface — `/admin/chat/delete-message`,
// `/admin/chat/list-messages`, `/admin/chat/set-room-config` — are
// Manager/Designer-gated per-app operator actions, not developer-facing.
// They are intentionally NOT wrapped by this client; use `tfl5.raw(path,
// body)` with an operator session if you need them. Note also that a
// `set-room-config` change is NOT pushed to already-open sockets — it only
// takes effect on the next `/ws/chat` upgrade or `/app/chat/history` call.

import type { HttpCore } from "./http.js";

// ============================================================
// REST history
// ============================================================

export interface ChatHistoryInput {
  /** Defaults to `"general"` server-side when omitted or empty. */
  room?: string;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /**
   * Reverse-chronological cursor: returns messages whose `ts` is strictly
   * less than this value. Omit for the most recent page. Pass the
   * previous response's `next_before_ts` to paginate further back.
   */
  before_ts?: number;
}

export interface ChatMessage {
  tid: string;
  from_user_tid: string;
  /** Sender's display name at send time. */
  from: string;
  text: string;
  /** Epoch-ms. */
  ts: number;
}

export interface ChatHistoryResult {
  app_tid: string;
  room: string;
  /** Newest first. */
  messages: ChatMessage[];
  /** Cursor for the next (older) page — pass as `before_ts` to paginate.
   *  `null` when this is the last page. */
  next_before_ts: number | null;
}

// ============================================================
// Live WebSocket — /ws/chat
// ============================================================

/** A `msg` frame is a superset of {@link ChatMessage}: it adds the
 *  discriminant `type` and the `room` it was posted to (history's
 *  `ChatMessage` carries neither, since the room is implicit in the
 *  request). Don't assume the two shapes are interchangeable. */
export interface ChatWsMsgEvent extends ChatMessage {
  type: "msg";
  room: string;
}

export interface ChatWsWelcomeEvent {
  type: "welcome";
  username: string;
  app_tid: string;
  room: string;
  ts: number;
}

export interface ChatWsPongEvent {
  type: "pong";
  ts: number;
}

/**
 * Observed `code` values: `"lagged"` (this connection's broadcast buffer
 * overflowed and dropped messages — a data-loss signal, not just noise),
 * `"invalid_json"`, `"empty_msg"`, `"persist_failed"`, `"unknown_type"`,
 * `"binary_unsupported"` (the server is text/JSON-only; a binary WS frame
 * is rejected). The connection stays open after any of these.
 */
export interface ChatWsErrorEvent {
  type: "error";
  code: string;
  msg: string;
  ts: number;
}

export type ChatServerEvent =
  | ChatWsWelcomeEvent
  | ChatWsMsgEvent
  | ChatWsPongEvent
  | ChatWsErrorEvent;

/**
 * Structural subset of the DOM `WebSocket` this wrapper needs — matches
 * both the browser global and Node `ws`-package sockets, so a Node/CLI
 * caller can pass a `ws` constructor via `WebSocketImpl` below.
 */
export interface ChatWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface ChatConnectOptions {
  /** Defaults to the client's scoped app (`useApp()` / config `appId`). */
  app_tid?: string;
  /** Defaults to `"general"` server-side. */
  room?: string;
  /** Called for every parsed server frame (in addition to the
   *  narrower `onMessage`/`onWelcome`/`onError` callbacks below). */
  onEvent?: (event: ChatServerEvent) => void;
  /** Convenience: called only for `type:"msg"` frames. */
  onMessage?: (msg: ChatWsMsgEvent) => void;
  onWelcome?: (event: ChatWsWelcomeEvent) => void;
  onError?: (event: ChatWsErrorEvent) => void;
  onOpen?: () => void;
  onClose?: (ev: unknown) => void;
  /**
   * A browser same-origin `WebSocket` handshake can't set custom headers —
   * it relies purely on the `_token` session cookie already present from a
   * cookie-mode login (verified: `chat_upgrade`'s auth resolves the same
   * cookie/bearer session as every other endpoint, via
   * `require_app_perm`/`cached_check_login`; there is no query-string
   * token param). In **bearer mode** (Node/CLI) there is no cookie to fall
   * back on — pass a `ws`-compatible `WebSocketImpl` below and put
   * `Authorization: Bearer <token>` in `wsOptions.headers`; a Node `ws`
   * client CAN set handshake headers even though a browser can't.
   */
  wsOptions?: Record<string, unknown>;
  /**
   * `WebSocket` constructor to use. Defaults to the global `WebSocket`
   * (browsers, and Node ≥22). Pass the `ws` package's export for older
   * Node / CLI usage.
   */
  WebSocketImpl?: new (
    url: string,
    protocols?: string | string[],
    options?: unknown,
  ) => ChatWebSocketLike;
}

/**
 * A live `/ws/chat` connection. Construct via {@link ChatClient.connect},
 * not directly.
 */
export class ChatSocket {
  private readonly ws: ChatWebSocketLike;

  constructor(url: string, opts: ChatConnectOptions) {
    const Impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket;
    if (!Impl) {
      throw new Error(
        "@tfl5/sdk: no global WebSocket found — pass `WebSocketImpl` in the config " +
          "(e.g. the `ws` package on Node < 22).",
      );
    }
    const Ctor = Impl as new (
      url: string,
      protocols?: string | string[],
      options?: unknown,
    ) => ChatWebSocketLike;
    this.ws = opts.wsOptions ? new Ctor(url, undefined, opts.wsOptions) : new Ctor(url);

    this.ws.onopen = () => opts.onOpen?.();
    this.ws.onclose = (ev) => opts.onClose?.(ev);
    this.ws.onerror = (ev) => opts.onError?.({ type: "error", code: "socket_error", msg: String(ev), ts: Date.now() });
    this.ws.onmessage = (ev) => {
      let parsed: ChatServerEvent;
      try {
        parsed = JSON.parse(String(ev.data)) as ChatServerEvent;
      } catch {
        return; // Malformed frame from a misbehaving proxy — nothing to dispatch.
      }
      opts.onEvent?.(parsed);
      if (parsed.type === "msg") opts.onMessage?.(parsed);
      else if (parsed.type === "welcome") opts.onWelcome?.(parsed);
      else if (parsed.type === "error") opts.onError?.(parsed);
    };
  }

  /** Post a chat message to the room this socket is connected to (the room
   *  is fixed for the connection's lifetime — there is no per-message room
   *  override). */
  send(text: string): void {
    this.ws.send(JSON.stringify({ type: "msg", text }));
  }

  /** Optional keepalive/liveness probe; the server replies with a `pong` frame. */
  ping(): void {
    this.ws.send(JSON.stringify({ type: "ping" }));
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}

// ============================================================
// Client
// ============================================================

export class ChatClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Fetch persisted chat history for a room, newest first. Access is
   * controlled by the room's configured `min_level` (Reader by default;
   * an app Designer can raise it via the admin-only
   * `/admin/chat/set-room-config`, not wrapped here).
   *
   * Paginate by passing the returned `next_before_ts` as `before_ts` on
   * the next call.
   */
  history(input: ChatHistoryInput = {}): Promise<ChatHistoryResult> {
    return this.http.post<ChatHistoryResult>("/app/chat/history", input);
  }

  /**
   * Open a live connection to a room. Delivers only messages sent AFTER
   * the connection is established (see the file-header pattern note) — call
   * {@link history} first for backfill.
   *
   * Cookie-mode (browser): works out of the box as long as you're already
   * signed in — the handshake is a same-origin request and the browser
   * attaches the session cookie automatically.
   *
   * Bearer-mode (Node/CLI): pass `WebSocketImpl` (e.g. the `ws` package)
   * and `wsOptions: { headers: { Authorization: "Bearer <token>" } }`.
   */
  connect(opts: ChatConnectOptions = {}): ChatSocket {
    const appTid = opts.app_tid ?? this.http.appId;
    if (!appTid) {
      throw new Error(
        "@tfl5/sdk: chat.connect() needs app_tid — pass it, or call tfl5.useApp(...) first.",
      );
    }
    const wsHost = this.http.host.replace(/^http/, "ws");
    const params = new URLSearchParams({ app_tid: appTid });
    if (opts.room) params.set("room", opts.room);
    const url = `${wsHost}/ws/chat?${params.toString()}`;
    return new ChatSocket(url, opts);
  }
}
