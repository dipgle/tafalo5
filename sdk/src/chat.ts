// ChatClient — per-app chat: REST scrollback (`/app/chat/history`) plus a
// thin wrapper around the live WebSocket (`/ws/chat`,
// crates/routes/src/ws_chat.rs).
//
// THE CORE PATTERN — a room's messages reach you from THREE sources, and
// the same message can arrive from more than one of them:
//   1. `history()` — the at-rest scrollback. Pages BACKWARD (`before_ts`)
//      and, since the reconnect fix, FORWARD (`after_ts`).
//   2. Live `msg` frames off the room's broadcast bus, for anything sent
//      while the socket is open.
//   3. Gap-fill `msg` frames the socket itself replays when you open it
//      with `since_ts` (below). Those are tagged `resumed: true`.
// So a message landing in the window between a socket's subscribe and a
// REST fetch — or one that falls inside a resume overlap — is delivered
// twice. When you splice frames onto a history list, DEDUPE BY `tid`;
// never assume the streams are disjoint. At-least-once is deliberate on
// the server side (ws_chat.rs `replay_since`): replaying a message twice
// is cheap, losing one is not.
//
// RETRACTIONS ARE FRAMES, NOT A REST CONCERN. A moderator delete fans
// `{"type":"deleted","tid","room","ts"}` out to every socket in the room —
// the local bus plus a cross-cell `chat_delete_v1` NOTIFY, so a delete
// reaches windows served by other cells too. A client that ignores the
// frame leaves a retracted message on screen until the user reloads,
// including in the moderator's own other windows. Handle it via
// `onDeleted` (remove the row by `tid`) and let the frame's `ts` advance
// your resume cursor, so the retracted row is not replayed forever.
//
// RECONNECT WITHOUT A HOLE. Pass `since_ts` (see {@link
// ChatConnectOptions.since_ts} and {@link chatResumeCursor}) and the server
// replays every `chat_message` newer than the cursor, oldest-first, BEFORE
// the socket goes live. The cursor is EXCLUSIVE (`created_at > since_ts`)
// and timestamps have millisecond resolution, so pass `lastSeenTs - 1` or
// two messages written in the same millisecond will lose the second one.
// Gaps larger than the server's `RESUME_REPLAY_CAP` (200 messages), and a
// failed replay query, degrade to `{"type":"error","code":"lagged"}` — the
// same signal a broadcast-buffer overflow raises, and the same recovery:
// refetch `history()`. Tombstoned rows are excluded from the replay, so a
// message posted AND deleted inside the gap correctly never appears.
//
// ADMIN/MODERATION endpoints on this surface. `/admin/chat/delete-message`
// and `/admin/chat/list-messages` remain deliberately unwrapped — they are
// per-message Manager operator actions with no shape trap; reach them with
// `tfl5.raw(path, body)` under an operator session. The room-CONFIG pair is
// wrapped (see {@link ChatClient.getRoomConfig} /
// {@link ChatClient.setRoomConfig} / {@link ChatClient.removeRoomConfig})
// because its write is destructive BY OMISSION: `set-room-config` sent with
// neither `min_level` nor `scope_attrs` deletes the whole room entry,
// scope binding included (ws_chat.rs `admin_set_room_config`). Leaving that
// to `raw()` means every console re-implements the guard, or trips it. Note
// also that a room-config change is NOT pushed to already-open sockets — it
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
  /**
   * Forward cursor: returns only messages whose `ts` is strictly GREATER
   * than this value — "everything after message N", answerable at rest.
   * Use it to fill a gap without refetching and diffing a whole page
   * (e.g. after a socket outage when you don't want the socket's own
   * `since_ts` replay).
   *
   * Composes with `before_ts`, which bounds the other end of the window.
   * The page is still returned NEWEST FIRST and still capped at `limit`:
   * when a windowed page comes back FULL, the window is wider than one
   * page — keep the same `after_ts` and walk backwards with
   * `next_before_ts` until the page is short.
   */
  after_ts?: number;
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
  /**
   * Cursor for the next (older) page — pass as `before_ts` to paginate.
   * This is the OLDEST row on this page, so it is `null` only when the
   * page came back EMPTY, not on the last non-empty page: page until you
   * get an empty page (or a page shorter than `limit`), don't wait for
   * this to be `null` on a page that has rows.
   */
  next_before_ts: number | null;
  /**
   * Cursor for "everything that arrives after what I just read" — the
   * NEWEST row on this page. Feed it back as `after_ts` on a later call.
   * `null` on an empty page, where the caller should keep the cursor it
   * already had rather than resetting it.
   */
  next_after_ts: number | null;
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
  /**
   * `true` only on a frame the server replayed to fill a reconnect gap
   * (the `since_ts` path). Absent on live traffic.
   *
   * Both kinds are real, persisted messages and render identically — the
   * flag exists so a client can tell them apart instead of guessing.
   * Treat it as an ordering hint, not a filter: replayed frames arrive
   * OLDEST-FIRST and before any live frame on that socket, and they may
   * repeat messages you already hold (the cursor is exclusive but clients
   * are told to overlap by 1ms). Dedupe by `tid` either way.
   */
  resumed?: boolean;
}

/**
 * A retraction: the message `tid` was soft-deleted by a moderator and must
 * leave the screen. Fanned out to every socket in `(app_tid, room)`,
 * across cells.
 *
 * `ts` is the deletion time, not the message's send time. Two consequences
 * worth handling:
 *   - It is safe (and expected) to receive a tombstone for a `tid` this
 *     client never rendered — the message may predate the connection, or
 *     have been scrolled past. Ignore the miss; do not treat it as an error.
 *   - Advance your resume cursor with it. Otherwise the deletion time sits
 *     ahead of your cursor forever and every reconnect replays the window
 *     around it again.
 */
export interface ChatWsDeletedEvent {
  type: "deleted";
  /** `tid` of the retracted {@link ChatMessage}. */
  tid: string;
  room: string;
  /** Epoch-ms the row was tombstoned. */
  ts: number;
}

export interface ChatWsWelcomeEvent {
  type: "welcome";
  username: string;
  app_tid: string;
  room: string;
  ts: number;
  /**
   * The `since_ts` cursor the server accepted for this connection, echoed
   * back — `null` on a first connect (no resume requested). Use it to
   * confirm a reconnect actually asked for the gap it meant to: a resume
   * cursor that silently failed to reach the server shows up here as
   * `null` while the socket still looks healthy.
   *
   * Any replayed `msg` frames arrive AFTER this frame and before live
   * traffic.
   */
  resume_from: number | null;
}

export interface ChatWsPongEvent {
  type: "pong";
  ts: number;
}

/**
 * Observed `code` values: `"lagged"` (data loss on this connection — see
 * {@link ChatConnectOptions.onLagged}: either the broadcast buffer
 * overflowed, or a `since_ts` resume gap exceeded the server's 200-message
 * cap, or the replay query itself failed), `"invalid_json"`, `"empty_msg"`,
 * `"persist_failed"`, `"unknown_type"`, `"binary_unsupported"` (the server
 * is text/JSON-only; a binary WS frame is rejected). The connection stays
 * open after any of these.
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

/**
 * Turn the newest `ts` you hold into a `since_ts` resume cursor.
 *
 * The server's cursor is EXCLUSIVE (`created_at > since_ts`) and
 * `chat_message.created_at` has millisecond resolution, so passing your
 * newest `ts` verbatim drops any second message written in that same
 * millisecond. This subtracts 1ms: the overlap re-delivers at most a
 * handful of frames, which your `tid` dedupe already absorbs.
 *
 * Only meaningful when you actually hold a message. With an empty view
 * omit `since_ts` and backfill with {@link ChatClient.history} — a cursor
 * of 0 would ask the server to replay the room from the beginning, which
 * on any real room answers `lagged` instead.
 *
 * @example
 * const socket = tfl5.chat.connect({
 *   room,
 *   since_ts: lastSeenTs > 0 ? chatResumeCursor(lastSeenTs) : undefined,
 *   onMessage: (m) => { if (!seen.has(m.tid)) render(m); },
 * });
 */
export function chatResumeCursor(lastSeenTs: number): number {
  if (!Number.isSafeInteger(lastSeenTs) || lastSeenTs <= 0) {
    throw new Error(
      `@tfl5/sdk: chatResumeCursor() needs the epoch-ms \`ts\` of a message you hold, got ${String(
        lastSeenTs,
      )} — omit \`since_ts\` and use chat.history() when the view is empty.`,
    );
  }
  return lastSeenTs - 1;
}

export interface ChatConnectOptions {
  /** Defaults to the client's scoped app (`useApp()` / config `appId`). */
  app_tid?: string;
  /** Defaults to `"general"` server-side. */
  room?: string;
  /**
   * Resume cursor, epoch-ms. Present on a RECONNECT: the server replays
   * every message newer than this before the socket goes live, so the
   * reconnect window no longer swallows messages. Omit on a first connect
   * and backfill with {@link ChatClient.history} instead.
   *
   * EXCLUSIVE and millisecond-resolution — derive it with {@link
   * chatResumeCursor}(newestTsYouHold) rather than passing the raw `ts`.
   * Replayed frames carry `resumed: true`; a gap over 200 messages (or a
   * failed replay query) answers `lagged` instead — see {@link onLagged}.
   */
  since_ts?: number;
  /** Called for every parsed server frame (in addition to the
   *  narrower `onMessage`/`onDeleted`/`onWelcome`/`onError` callbacks
   *  below). */
  onEvent?: (event: ChatServerEvent) => void;
  /** Convenience: called for every `type:"msg"` frame, live or replayed.
   *  Check `msg.resumed` to tell them apart, and dedupe by `msg.tid` —
   *  the same message can legitimately arrive twice. */
  onMessage?: (msg: ChatWsMsgEvent) => void;
  /**
   * Called for every `type:"deleted"` frame: drop the message with that
   * `tid` from the view. A client without this handler shows retracted
   * messages until the user reloads the page.
   */
  onDeleted?: (event: ChatWsDeletedEvent) => void;
  onWelcome?: (event: ChatWsWelcomeEvent) => void;
  onError?: (event: ChatWsErrorEvent) => void;
  /**
   * Called for the `lagged` error specifically — the one error code that
   * means MESSAGES WERE LOST on this connection (buffer overflow, or a
   * resume gap past the server's cap, or a failed replay query). The
   * socket stays open and keeps delivering live traffic; the correct
   * recovery is to refetch {@link ChatClient.history} and rebuild the
   * view, not to reconnect.
   *
   * Fires IN ADDITION to `onError`, which still sees the same frame.
   */
  onLagged?: (event: ChatWsErrorEvent) => void;
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
      else if (parsed.type === "deleted") opts.onDeleted?.(parsed);
      else if (parsed.type === "welcome") opts.onWelcome?.(parsed);
      else if (parsed.type === "error") {
        opts.onError?.(parsed);
        // `lagged` is the data-loss code, routed separately so a caller can
        // trigger a history refetch without string-matching every error.
        if (parsed.code === "lagged") opts.onLagged?.(parsed);
      }
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
// Room config (`/admin/chat/{get,set}-room-config`) — Designer+
// ============================================================

/** Per-room minimum app permission level. A room with no config resolves
 *  to `Reader`. */
export type ChatRoomMinLevel = "Reader" | "Editor" | "Designer" | "Manager";

/**
 * Row-level scope binding for a room: a FLAT object of `{column: value}`
 * matching the resource's `field_map`. Values must be strings — the
 * server rejects nested objects, arrays, numbers and booleans with
 * `chat_room_scope_attrs_invalid`, because the scope row-predicate only
 * compares strings and a nested value would silently match nothing (i.e.
 * lock everyone out).
 */
export type ChatRoomScopeAttrs = Record<string, string>;

export interface ChatRoomConfigInput {
  /** Room name. Must be non-empty. NOT trimmed by the server: a room
   *  stored as `" lobby"` stays visible as the typo it is. */
  room: string;
  /** Defaults to the client's scoped app (`useApp()` / config `appId`). */
  app_tid?: string;
}

export interface ChatRoomConfigResult {
  app_tid: string;
  room: string;
  /**
   * `false` when the room has no config entry at all. Reported separately
   * from the values on purpose: an unconfigured room and a room explicitly
   * pinned to `Reader` resolve to the SAME effective level, and only the
   * second one has anything for {@link ChatClient.removeRoomConfig} to
   * destroy. Don't infer "configured" from `min_level` being set.
   */
  configured: boolean;
  /**
   * The stored value, RAW — `null` when unset. Not resolved to the
   * effective level: answering `"Reader"` for an unconfigured room would
   * make a screen display a restriction nobody set, then save it back as
   * one.
   *
   * Typed as the four valid levels because that is all
   * {@link ChatClient.setRoomConfig} can write (`chat_room_level_invalid`
   * rejects the rest). A value outside them can still reach this field —
   * a restore or a hand-edited `apps.acls` row — and the platform's read
   * path resolves any such string to `Reader` while logging a warning. If
   * your screen switches exhaustively on this, keep a default branch.
   */
  min_level: ChatRoomMinLevel | null;
  /** Stored scope binding; `{}` when none is set. */
  scope_attrs: ChatRoomScopeAttrs;
}

/**
 * At least one of `min_level` / `scope_attrs` is REQUIRED — sending
 * neither is the platform's "remove the whole room entry" branch, which
 * this SDK exposes as the explicit {@link ChatClient.removeRoomConfig}
 * instead. An omitted field is left untouched (partial set); an explicit
 * `scope_attrs: {}` clears the binding.
 */
export type ChatSetRoomConfigInput = ChatRoomConfigInput &
  (
    | { min_level: ChatRoomMinLevel; scope_attrs?: ChatRoomScopeAttrs }
    | { min_level?: ChatRoomMinLevel; scope_attrs: ChatRoomScopeAttrs }
  );

/** Result of {@link ChatClient.setRoomConfig} — echoes only the fields the
 *  call actually wrote (an omitted field stays whatever it was; re-read
 *  with {@link ChatClient.getRoomConfig} for the full picture). */
export interface ChatSetRoomConfigResult {
  app_tid: string;
  room: string;
  min_level?: ChatRoomMinLevel | null;
  scope_attrs?: ChatRoomScopeAttrs | null;
}

/** Result of {@link ChatClient.removeRoomConfig}. */
export interface ChatRemoveRoomConfigResult {
  app_tid: string;
  room: string;
  /** Always `true` on success. The server does not distinguish "there was
   *  no entry" from "the entry is gone", so this is not a row count. */
  removed: boolean;
}

// ============================================================
// Client
// ============================================================

export class ChatClient {
  constructor(private readonly http: HttpCore) {}

  /**
   * Fetch persisted chat history for a room, newest first. Access is
   * controlled by the room's configured `min_level` (Reader by default;
   * an app Designer can raise it — see {@link setRoomConfig}) and by the
   * room's `scope_attrs` binding when the app opts into row-level scope.
   *
   * Paginate BACKWARD by passing the returned `next_before_ts` as
   * `before_ts`. Fill a forward gap by passing a known `ts` as `after_ts`
   * and walking `next_before_ts` until the page comes back short.
   */
  history(input: ChatHistoryInput = {}): Promise<ChatHistoryResult> {
    return this.http.post<ChatHistoryResult>("/app/chat/history", input);
  }

  /**
   * Open a live connection to a room.
   *
   * Without `since_ts` the socket delivers only messages sent AFTER the
   * connection is established — call {@link history} first for backfill.
   * With `since_ts` (a RECONNECT) the server first replays the gap, each
   * frame tagged `resumed: true`, then goes live. Either way, handle
   * `onDeleted` or retracted messages stay on screen, and dedupe by `tid`.
   *
   * Cookie-mode (browser): works out of the box as long as you're already
   * signed in — the handshake is a same-origin request and the browser
   * attaches the session cookie automatically.
   *
   * Bearer-mode (Node/CLI): pass `WebSocketImpl` (e.g. the `ws` package)
   * and `wsOptions: { headers: { Authorization: "Bearer <token>" } }`.
   *
   * @example
   * // Reconnect loop that neither loses nor double-renders a message.
   * const seen = new Set<string>();
   * let lastTs = 0;
   * const open = () =>
   *   tfl5.chat.connect({
   *     room: "general",
   *     since_ts: lastTs > 0 ? chatResumeCursor(lastTs) : undefined,
   *     onMessage: (m) => {
   *       lastTs = Math.max(lastTs, m.ts);
   *       if (seen.has(m.tid)) return; // resume overlap, or history race
   *       seen.add(m.tid);
   *       render(m);
   *     },
   *     onDeleted: (d) => {
   *       seen.delete(d.tid);
   *       lastTs = Math.max(lastTs, d.ts); // don't replay the tombstone forever
   *       removeRow(d.tid);
   *     },
   *     onLagged: async () => {
   *       // Messages were lost — rebuild from the source of truth.
   *       const page = await tfl5.chat.history({ room: "general" });
   *       reset(page.messages);
   *     },
   *     onClose: () => setTimeout(open, 3000),
   *   });
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
    if (opts.since_ts !== undefined) {
      // The server deserializes `since_ts` as an i64; a fractional or
      // non-finite value fails the query parse and the upgrade is rejected
      // outright. Refuse it here, where the caller can see which value was
      // wrong, instead of surfacing it as a dead socket.
      if (!Number.isSafeInteger(opts.since_ts)) {
        throw new Error(
          `@tfl5/sdk: chat.connect() since_ts must be an integer epoch-ms cursor, got ${String(
            opts.since_ts,
          )} — see chatResumeCursor().`,
        );
      }
      params.set("since_ts", String(opts.since_ts));
    }
    const url = `${wsHost}/ws/chat?${params.toString()}`;
    return new ChatSocket(url, opts);
  }

  /**
   * Read a room's stored config (`/admin/chat/get-room-config`, Designer+).
   *
   * Call this BEFORE {@link setRoomConfig} from any screen that edits a
   * room: the write is a partial set, so a console that shows only
   * `min_level` is editing on top of a `scope_attrs` binding it never
   * displayed — and one that offers a "clear" button can delete that
   * binding without ever having read it.
   */
  getRoomConfig(input: ChatRoomConfigInput): Promise<ChatRoomConfigResult> {
    return this.http.post<ChatRoomConfigResult>("/admin/chat/get-room-config", input);
  }

  /**
   * Set a room's `min_level` and/or `scope_attrs`
   * (`/admin/chat/set-room-config`, Designer+). A field you omit is left
   * untouched; `scope_attrs: {}` explicitly clears the binding.
   *
   * At least one of the two is required — the platform treats "neither
   * field present" as DELETE THE WHOLE ROOM ENTRY, so that branch lives in
   * {@link removeRoomConfig} where it has to be asked for by name. Passing
   * neither throws here rather than reaching the server.
   *
   * Server-side validation you can switch on: `chat_room_required`,
   * `chat_room_level_invalid` (unknown `min_level`),
   * `chat_room_scope_attrs_invalid` (not a flat object of strings). The
   * change takes effect on the next `/ws/chat` upgrade or `history()` call
   * — it is NOT pushed to already-open sockets.
   */
  setRoomConfig(input: ChatSetRoomConfigInput): Promise<ChatSetRoomConfigResult> {
    const { min_level, scope_attrs } = input as {
      min_level?: ChatRoomMinLevel;
      scope_attrs?: ChatRoomScopeAttrs;
    };
    if (min_level === undefined && scope_attrs === undefined) {
      throw new Error(
        "@tfl5/sdk: chat.setRoomConfig() needs min_level and/or scope_attrs — sending " +
          "neither would DELETE the room's whole config entry (scope binding included). " +
          "Call chat.removeRoomConfig({ room }) if that is what you want.",
      );
    }
    return this.http.post<ChatSetRoomConfigResult>("/admin/chat/set-room-config", input);
  }

  /**
   * Delete a room's config entry entirely, reverting it to platform
   * defaults: `min_level` back to Reader, and NO scope binding — which,
   * under row-level scope enforcement, means the room becomes opt-out and
   * is denied to non-Global callers. This is the destructive branch of
   * `/admin/chat/set-room-config`; it takes both fields away, not just the
   * one a screen happens to be showing. Read {@link getRoomConfig} first.
   */
  removeRoomConfig(input: ChatRoomConfigInput): Promise<ChatRemoveRoomConfigResult> {
    // Deliberately sends ONLY app_tid + room: that omission IS the server's
    // remove branch (ws_chat.rs `admin_set_room_config`).
    return this.http.post<ChatRemoveRoomConfigResult>("/admin/chat/set-room-config", {
      room: input.room,
      ...(input.app_tid !== undefined ? { app_tid: input.app_tid } : {}),
    });
  }
}
