# Realtime: durable operators, live projections, chat

## Durable operator instances

A durable instance is a long-lived piece of your own server-side code (a
WASM operator) with its own persistent state, addressed by
`(app, opId, instanceKey)` — for example one instance per game room or per
shopping cart. The server creates it on the first message and runs messages
to one instance one at a time.

```ts
const res = await tfl5.durable.send({
  appTid,
  opId: "counter",
  instanceKey: "room-42",
  msg: { action: "increment", by: 1 },
  idemKey: crypto.randomUUID(),     // retry with the same key = delivered once
});
if (res.result) console.log(res.data);
else if (res.retryable) retryLater();   // same idemKey
```

`send()` does not throw when a message was not delivered; it resolves
`result: false` with a `code` (see the `DurableSendResult` type), and sets
`retryable` for the codes worth retrying (`instance_busy`, `wrong_cell`,
`cell_forward_failed`, `instance_quota`, `tick_deadline`). It throws only
for request errors (auth, validation, server faults).

- `tfl5.durable.stats({ opId, instanceKey })` — metering counters; a
  never-activated instance reads `seq: -1`.
- `tfl5.durable.grantMail({ senderAppTid, opId? })` — allow another app's
  operators to message this app's operators (Manager); `revokeMail`,
  `listMailGrants` manage the list.

Durable operators must be enabled on the server; otherwise calls answer
`durable_disabled`. Operator ids and instance keys are 1–64 characters of
`[A-Za-z0-9_-]`.

## Live projections

Operators can publish rows ("projections") under `(resource, key)`. A page
subscribes over one WebSocket and keeps an up-to-date local copy:

```ts
const sub = tfl5.durable.subscribe(
  { appTid, resource: "board", keys: ["k1", "k2"] },          // or subs: [{ resource, key }, …]
  {
    onUpdate: (rows, key) => render(key, sub.rows(key)),
    onStatus: (s) => setBadge(s),                             // "connecting" | "live" | "behind" | "closed"
  },
);
// later
sub.close();
```

The subscription starts from a snapshot, applies deltas, and resyncs by
itself when it notices it missed one. Rows are filtered by the viewer's
access the same way `list()` is.

In Node, pass a WebSocket factory that can send the session cookie, for
example with the `ws` package:

```ts
tfl5.durable.subscribe(input, {
  webSocket: (url) => new WebSocket(url, { headers: { cookie: `_token=${token}` } }),
});
```

## Chat

History over HTTP:

```ts
const page = await tfl5.chat.history({ room: "general", limit: 50 });
// page.messages newest first; page.next_before_ts pages back,
// page.next_after_ts pages forward (pass as after_ts)
```

Live messages:

```ts
import { chatResumeCursor } from "@tfl5/sdk";

const seen = new Set<string>();
let lastTs = 0;
const open = () =>
  tfl5.chat.connect({
    room: "general",
    since_ts: lastTs > 0 ? chatResumeCursor(lastTs) : undefined,   // replay what was missed
    onMessage: (m) => { lastTs = Math.max(lastTs, m.ts); if (!seen.has(m.tid)) { seen.add(m.tid); render(m); } },
    onDeleted: (d) => { lastTs = Math.max(lastTs, d.ts); removeRow(d.tid); },
    onLagged: async () => reset((await tfl5.chat.history({ room: "general" })).messages),
    onClose: () => setTimeout(open, 3000),
  });
const socket = open();
socket.send("hello");
```

Messages can arrive both from `history()` and from the socket, so
deduplicate by `tid`. In Node the SDK passes the session to the handshake
itself (Node 22+ has a built-in `WebSocket`; pass `webSocket` for other
implementations). Room access: `chat.getRoomConfig`, `setRoomConfig`
(`min_level`, `scope_attrs`; Designer) and `removeRoomConfig`.

The wire protocol, for other clients:

**Connect** `wss://<host>/ws/chat?app_tid=<app>&room=<room>&since_ts=<ms>`
with the session cookie. `room` defaults to `general`. Pass `since_ts` on a
reconnect and the server replays what you missed; the cursor is exclusive and
millisecond-grained, so pass the newest `ts` you hold minus 1.
Access follows the room's configured minimum level (Reader by default); a
refusal happens before the upgrade, so a browser only sees the connection
fail.

**Client → server** (JSON text frames):

| STT | Frame | Effect |
|---|---|---|
| 1 | `{"type":"msg","text":"hi"}` | store and broadcast the message (you receive your own copy) |
| 2 | `{"type":"ping"}` | server answers `pong` |

**Server → client:**

| STT | Frame | Meaning |
|---|---|---|
| 1 | `{"type":"welcome","username","app_tid","room","resume_from","ts"}` | first frame |
| 2 | `{"type":"msg","tid","from","from_user_tid","room","text","ts","resumed"?}` | a message (`resumed: true` when replayed) |
| 3 | `{"type":"deleted","tid","room","ts"}` | a moderator removed a message |
| 4 | `{"type":"pong","ts"}` | answer to `ping` |
| 5 | `{"type":"error","code","msg","ts"}` | `lagged` (too far behind — reload history), `persist_failed` (the message was not stored), `empty_msg`, `invalid_json`, `unknown_type`, `binary_unsupported` |

The connection stays open after an `error` frame about a bad client frame.
