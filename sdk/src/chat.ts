// ChatClient — per-app chat: HTTP scrollback (`/app/chat/history`), a live
// WebSocket (`/ws/chat`), and per-room access settings.
//
// A room's messages reach you from three sources, and the same message can
// arrive from more than one of them:
//   1. `history()` — the stored scrollback (backward with `before_ts`,
//      forward with `after_ts`);
//   2. live `msg` frames for anything sent while the socket is open;
//   3. frames the socket replays when you reconnect with `since_ts`
//      (tagged `resumed: true`).
// Deduplicate by `tid` when you merge them. Replaying a message twice is
// cheap; losing one is not, so the server errs on the side of duplicates.
//
// Moderator deletions arrive as `deleted` frames on every socket in the
// room. Handle `onDeleted` or retracted messages stay on screen.

import type { HttpCore } from "./http.js";

// ---- History -----------------------------------------------------------

export interface ChatHistoryInput {
  /** Defaults to `"general"`. */
  room?: string;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Only messages strictly older than this `ts`. Pass the previous page's `next_before_ts`. */
  before_ts?: number;
  /**
   * Only messages strictly newer than this `ts` (fills a gap). The page is
   * still newest first and capped at `limit`: when it comes back full, keep
   * `after_ts` and walk backwards with `next_before_ts` until a page is short.
   */
  after_ts?: number;
}

export interface ChatMessage {
  tid: string;
  from_user_tid: string;
  /** Sender's display name at send time. */
  from: string;
  text: string;
  /** Epoch ms. */
  ts: number;
}

export interface ChatHistoryResult {
  app_tid: string;
  room: string;
  /** Newest first. */
  messages: ChatMessage[];
  /** Oldest `ts` on this page (pass as `before_ts`); `null` only when the page is empty. */
  next_before_ts: number | null;
  /** Newest `ts` on this page (pass as `after_ts` later); `null` when the page is empty. */
  next_after_ts: number | null;
}

// ---- Live socket frames -------------------------------------------------

/** A message frame: a {@link ChatMessage} plus `type` and `room`. */
export interface ChatWsMsgEvent extends ChatMessage {
  type: "msg";
  room: string;
  /** `true` on frames replayed after a reconnect (`since_ts`); they arrive oldest first. */
  resumed?: boolean;
}

/** A moderator removed message `tid`. `ts` is the deletion time; advance your resume cursor with it. */
export interface ChatWsDeletedEvent {
  type: "deleted";
  tid: string;
  room: string;
  ts: number;
}

export interface ChatWsWelcomeEvent {
  type: "welcome";
  username: string;
  app_tid: string;
  room: string;
  ts: number;
  /** The `since_ts` the server accepted; `null` on a first connect. */
  resume_from: number | null;
}

export interface ChatWsPongEvent {
  type: "pong";
  ts: number;
}

/**
 * Codes: `lagged` (messages were lost on this connection — refetch
 * `history()`), `persist_failed`, `empty_msg`, `invalid_json`,
 * `unknown_type`, `binary_unsupported`. The connection stays open.
 * `socket_error` is added by the SDK for transport errors.
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
  | ChatWsDeletedEvent
  | ChatWsPongEvent
  | ChatWsErrorEvent;

/** The part of a `WebSocket` this client uses (browser, Node ≥ 22, or the `ws` package). */
export interface ChatWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/**
 * Turn the newest `ts` you hold into a `since_ts` resume cursor. The
 * server's cursor is exclusive and millisecond-grained, so this subtracts
 * 1 ms to keep a second message from the same millisecond; dedupe by `tid`
 * absorbs the overlap. With an empty view, omit `since_ts` and use
 * `history()` instead.
 */
export function chatResumeCursor(lastSeenTs: number): number {
  if (!Number.isSafeInteger(lastSeenTs) || lastSeenTs <= 0) {
    throw new Error(
      `@tfl5/sdk: chatResumeCursor() needs the epoch-ms ts of a message you hold, got ${String(lastSeenTs)}`,
    );
  }
  return lastSeenTs - 1;
}

export interface ChatConnectOptions {
  /** Defaults to the client's scoped app. */
  app_tid?: string;
  /** Defaults to `"general"`. */
  room?: string;
  /** Resume cursor on a reconnect — use {@link chatResumeCursor}. */
  since_ts?: number;
  /** Every parsed frame. */
  onEvent?: (event: ChatServerEvent) => void;
  /** Message frames, live or replayed (check `resumed`; dedupe by `tid`). */
  onMessage?: (msg: ChatWsMsgEvent) => void;
  /** Deletion frames: remove the message with that `tid`. */
  onDeleted?: (event: ChatWsDeletedEvent) => void;
  onWelcome?: (event: ChatWsWelcomeEvent) => void;
  onError?: (event: ChatWsErrorEvent) => void;
  /** `lagged` errors: messages were lost; refetch `history()` (the socket stays open). */
  onLagged?: (event: ChatWsErrorEvent) => void;
  onOpen?: () => void;
  onClose?: (ev: unknown) => void;
  /**
   * WebSocket factory. Defaults to the global `WebSocket`; outside a browser
   * the SDK passes the session (cookie jar or bearer token) as handshake
   * headers, which Node's built-in WebSocket supports. Pass a factory for
   * other implementations, e.g. `(url, headers) => new WS(url, { headers })`.
   */
  webSocket?: (url: string, headers: Record<string, string>) => ChatWebSocketLike;
}

const hasWindow = typeof window !== "undefined";

/** A live `/ws/chat` connection. Create it with {@link ChatClient.connect}. */
export class ChatSocket {
  private readonly ws: ChatWebSocketLike;

  constructor(url: string, headers: Record<string, string>, opts: ChatConnectOptions) {
    if (opts.webSocket) {
      this.ws = opts.webSocket(url, headers);
    } else {
      const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as
        | (new (url: string, init?: unknown) => ChatWebSocketLike)
        | undefined;
      if (!Ctor) {
        throw new Error("@tfl5/sdk: no global WebSocket — pass `webSocket` (e.g. the `ws` package).");
      }
      // Browsers send the cookie themselves and reject an init object;
      // Node's WebSocket accepts `{ headers }`.
      this.ws = !hasWindow && Object.keys(headers).length > 0 ? new Ctor(url, { headers }) : new Ctor(url);
    }
    this.ws.onopen = () => opts.onOpen?.();
    this.ws.onclose = (ev) => opts.onClose?.(ev);
    this.ws.onerror = (ev) =>
      opts.onError?.({ type: "error", code: "socket_error", msg: String((ev as { message?: string })?.message ?? ev), ts: Date.now() });
    this.ws.onmessage = (ev) => {
      let parsed: ChatServerEvent;
      try {
        parsed = JSON.parse(String(ev.data)) as ChatServerEvent;
      } catch {
        return;
      }
      opts.onEvent?.(parsed);
      if (parsed.type === "msg") opts.onMessage?.(parsed);
      else if (parsed.type === "deleted") opts.onDeleted?.(parsed);
      else if (parsed.type === "welcome") opts.onWelcome?.(parsed);
      else if (parsed.type === "error") {
        opts.onError?.(parsed);
        if (parsed.code === "lagged") opts.onLagged?.(parsed);
      }
    };
  }

  /** Post a message to this socket's room (you also receive it back). */
  send(text: string): void {
    this.ws.send(JSON.stringify({ type: "msg", text }));
  }

  /** The server answers with a `pong` frame. */
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

// ---- Room settings ------------------------------------------------------

/** Minimum app level needed to read and post in a room; unset means Reader. */
export type ChatRoomMinLevel = "Reader" | "Editor" | "Designer" | "Manager";

/** Flat `{attribute: value}` scope binding for a room (string values only). */
export type ChatRoomScopeAttrs = Record<string, string>;

export interface ChatRoomConfigInput {
  /** Room name (not trimmed by the server). */
  room: string;
  /** Defaults to the client's scoped app. */
  app_tid?: string;
}

export interface ChatRoomConfigResult {
  app_tid: string;
  room: string;
  /** `false` when the room has no stored settings. */
  configured: boolean;
  /** Stored value, `null` when unset (effective level is then Reader). */
  min_level: ChatRoomMinLevel | null;
  /** `{}` when no binding is set. */
  scope_attrs: ChatRoomScopeAttrs;
}

/** At least one of `min_level` / `scope_attrs`; an omitted one is left as it is. */
export type ChatSetRoomConfigInput = ChatRoomConfigInput &
  (
    | { min_level: ChatRoomMinLevel; scope_attrs?: ChatRoomScopeAttrs }
    | { min_level?: ChatRoomMinLevel; scope_attrs: ChatRoomScopeAttrs }
  );

export interface ChatSetRoomConfigResult {
  app_tid: string;
  room: string;
  /** Echoed; `null` for a field the call did not set. */
  min_level: ChatRoomMinLevel | null;
  scope_attrs: ChatRoomScopeAttrs | null;
}

export interface ChatRemoveRoomConfigResult {
  app_tid: string;
  room: string;
  removed: boolean;
}

// ---- Client -------------------------------------------------------------

export class ChatClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Stored messages of a room, newest first. Access follows the room's
   * `min_level` (Reader by default) and scope binding.
   */
  history(input: ChatHistoryInput = {}): Promise<ChatHistoryResult> {
    return this.http.post<ChatHistoryResult>("/app/chat/history", input);
  }

  /**
   * Open a live connection to a room. Without `since_ts` only messages sent
   * after the connection opens arrive — load `history()` first. A refused
   * connection (not signed in, not allowed) shows up only as a closed
   * socket, because the refusal happens before the WebSocket upgrade.
   *
   * @example
   * const seen = new Set<string>();
   * let lastTs = 0;
   * const open = () => tfl5.chat.connect({
   *   room: "general",
   *   since_ts: lastTs > 0 ? chatResumeCursor(lastTs) : undefined,
   *   onMessage: (m) => { lastTs = Math.max(lastTs, m.ts); if (!seen.has(m.tid)) { seen.add(m.tid); render(m); } },
   *   onDeleted: (d) => { lastTs = Math.max(lastTs, d.ts); removeRow(d.tid); },
   *   onLagged: async () => reset((await tfl5.chat.history({ room: "general" })).messages),
   *   onClose: () => setTimeout(open, 3000),
   * });
   */
  connect(opts: ChatConnectOptions = {}): ChatSocket {
    const appTid = opts.app_tid ?? this.http.appId;
    if (!appTid) throw new Error("@tfl5/sdk: chat.connect() needs app_tid — pass it or call tfl5.useApp().");
    if (!this.http.host) throw new Error("@tfl5/sdk: chat.connect() needs a `host` outside a browser.");
    const params = new URLSearchParams({ app_tid: appTid });
    if (opts.room) params.set("room", opts.room);
    if (opts.since_ts !== undefined) {
      if (!Number.isSafeInteger(opts.since_ts)) {
        throw new Error(`@tfl5/sdk: since_ts must be an integer epoch-ms cursor, got ${String(opts.since_ts)}`);
      }
      params.set("since_ts", String(opts.since_ts));
    }
    const url = `${this.http.host.replace(/^http/, "ws")}/ws/chat?${params.toString()}`;
    return new ChatSocket(url, hasWindow ? {} : this.http.authHeaders(), opts);
  }

  /**
   * A room's stored settings (Designer). Read them before `setRoomConfig`,
   * which changes only the fields you pass.
   */
  getRoomConfig(input: ChatRoomConfigInput): Promise<ChatRoomConfigResult> {
    return this.http.post<ChatRoomConfigResult>("/admin/chat/get-room-config", input);
  }

  /**
   * Set a room's `min_level` and/or `scope_attrs` (Designer). An omitted
   * field is left unchanged; `scope_attrs: {}` clears the binding. Sending
   * neither would delete the room's settings, so that is refused here —
   * use `removeRoomConfig()`. Takes effect on new connections and
   * `history()` calls, not on sockets already open.
   */
  setRoomConfig(input: ChatSetRoomConfigInput): Promise<ChatSetRoomConfigResult> {
    const { min_level, scope_attrs } = input as { min_level?: unknown; scope_attrs?: unknown };
    if (min_level == null && scope_attrs == null) {
      throw new Error(
        "@tfl5/sdk: chat.setRoomConfig() needs min_level and/or scope_attrs; sending neither deletes the room's settings — use removeRoomConfig().",
      );
    }
    return this.http.post<ChatSetRoomConfigResult>("/admin/chat/set-room-config", input);
  }

  /** Delete a room's settings: back to Reader and no scope binding (Designer). */
  removeRoomConfig(input: ChatRoomConfigInput): Promise<ChatRemoveRoomConfigResult> {
    return this.http.post<ChatRemoveRoomConfigResult>("/admin/chat/set-room-config", {
      room: input.room,
      ...(input.app_tid !== undefined ? { app_tid: input.app_tid } : {}),
    });
  }
}
