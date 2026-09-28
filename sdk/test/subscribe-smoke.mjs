// Smoke for DurableSubscription frame handling — runs the COMPILED dist
// artifact with an injected fake WebSocket factory (no network), covering:
// welcome→snapshot→live, latest-wins delta (stale seq dropped), heartbeat
// behind-detection with the in-flight-delta GRACE (catch-up cancels the
// resync; still-behind resyncs via reconnect + fresh snapshot), stale-socket
// event guard, factory-throw-on-reconnect back-off (no crash, no dead sub),
// and terminal close().
//
//   cd sdk && npm run build && node test/subscribe-smoke.mjs
//
// Exit 0 = all assertions passed.

import assert from "node:assert/strict";
import { TFL5 } from "../dist/index.js";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closeCalls = [];
  }
  frame(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  close(code, reason) {
    this.closeCalls.push({ code, reason });
    // Mirror real sockets: onclose fires async after close().
    queueMicrotask(() => this.onclose?.());
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

const sockets = [];
const updates = [];
const statuses = [];
const errors = [];

const tfl5 = new TFL5({ host: "http://cell.example", auth: "bearer" });
const sub = tfl5.durable.subscribe(
  { appTid: "a_smoke", resource: "board", key: "k1" },
  {
    webSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onUpdate: (rows) => updates.push(rows),
    onStatus: (st) => statuses.push(st),
    onError: (e) => errors.push(e),
  },
);

const s1 = sockets[0];
assert.equal(sockets.length, 1, "one socket opened");
assert.equal(
  s1.url,
  "ws://cell.example/ws/durable/subscribe?app_tid=a_smoke&resource=board&key=k1",
  "ws URL derived from host + query-encoded params",
);
assert.equal(sub.status, "connecting");

// welcome → snapshot: state replaced, live.
s1.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", key: "k1", ts: 1 });
s1.frame({
  type: "snapshot",
  rows: [
    { instance_tid: "di_b", seq: 3, doc: { n: 3 } },
    { instance_tid: "di_a", seq: 1, doc: { n: 1 } },
  ],
  ts: 2,
});
assert.equal(sub.status, "live", "snapshot flips to live");
assert.deepEqual(
  sub.rows().map((r) => r.instanceTid),
  ["di_a", "di_b"],
  "rows sorted by instanceTid",
);

// delta latest-wins: newer applies, stale dropped, equal re-applies.
s1.frame({ type: "delta", instance_tid: "di_a", seq: 2, doc: { n: 2 }, ts: 3 });
assert.equal(sub.get("di_a").doc.n, 2, "newer delta applied");
s1.frame({ type: "delta", instance_tid: "di_a", seq: 1, doc: { n: 99 }, ts: 4 });
assert.equal(sub.get("di_a").doc.n, 2, "stale delta dropped");
s1.frame({ type: "delta", instance_tid: "di_a", seq: 2, doc: { n: 22 }, ts: 5 });
assert.equal(sub.get("di_a").doc.n, 22, "same-seq delta re-applies (fresh re-read)");

// error frame is surfaced, stream continues.
s1.frame({ type: "error", code: "lagged", msg: "2 deltas dropped; snapshot follows", ts: 6 });
assert.equal(errors[0].code, "lagged");
assert.equal(sub.status, "live", "error frame does not kill the stream");

// heartbeat in sync → no grace timer, no resync.
s1.frame({ type: "heartbeat", rows: [{ instance_tid: "di_a", seq: 2 }], ts: 7 });
await sleep(1100);
assert.equal(sub.status, "live", "in-sync heartbeat is a no-op");
assert.equal(s1.closeCalls.length, 0);

// heartbeat ahead but the delta is in flight → grace catches up, NO resync.
s1.frame({ type: "heartbeat", rows: [{ instance_tid: "di_a", seq: 3 }], ts: 8 });
assert.equal(sub.status, "live", "grace pending — not flagged behind yet");
s1.frame({ type: "delta", instance_tid: "di_a", seq: 3, doc: { n: 3 }, ts: 9 });
await sleep(1100);
assert.equal(sub.status, "live", "in-flight delta cancelled the resync (grace)");
assert.equal(s1.closeCalls.length, 0, "no wasteful reconnect on a transient race");

// heartbeat ahead and nothing catches up → behind + resync after the grace.
s1.frame({ type: "heartbeat", rows: [{ instance_tid: "di_a", seq: 9 }], ts: 10 });
assert.equal(s1.closeCalls.length, 0, "resync deferred to the grace re-check");
await sleep(1100);
assert.ok(statuses.includes("behind"), "still-behind after grace flags behind");
assert.equal(s1.closeCalls.length, 1, "resync closes the socket");

// Reconnect: welcome resets back-off; fresh snapshot replaces state.
await sleep(1100);
assert.equal(sockets.length, 2, "resync reconnected");
const s2 = sockets[1];
s2.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", key: "k1", ts: 11 });
s2.frame({
  type: "snapshot",
  rows: [{ instance_tid: "di_a", seq: 9, doc: { n: 9 } }],
  ts: 12,
});
assert.equal(sub.status, "live", "fresh snapshot recovers");
assert.deepEqual(
  sub.rows().map((r) => [r.instanceTid, r.seq]),
  [["di_a", 9]],
  "snapshot REPLACED the state (di_b gone)",
);

// Stale-socket guard: late events from the replaced socket are ignored.
s1.frame({ type: "delta", instance_tid: "di_a", seq: 99, doc: { n: -1 }, ts: 13 });
assert.equal(sub.get("di_a").doc.n, 9, "late frame from the old socket ignored");
s1.onclose?.();
await sleep(1100);
assert.equal(sockets.length, 2, "old socket's late close does not spawn a reconnect");

// close() is terminal: no further reconnects.
sub.close();
assert.equal(sub.status, "closed");
assert.equal(s2.closeCalls.length, 1, "close() closed the live socket");
await sleep(1100);
assert.equal(sockets.length, 2, "no reconnect after terminal close");
// Exactly 5 applied changes: snapshot#1, delta seq2, same-seq re-apply,
// grace catch-up delta seq3, snapshot#2 (stale delta + heartbeats + late
// frames apply nothing).
assert.equal(updates.length, 5, "onUpdate fired once per applied change");
assert.deepEqual(
  [...new Set(statuses)],
  ["live", "behind", "connecting", "closed"],
  "status transitions observed (connecting emitted on resync; ctor state is initial)",
);

// P1 regression lock: a factory that THROWS on reconnect must not crash the
// process (uncaught in a timer callback) nor kill the retry loop.
const socks2 = [];
let calls = 0;
const sub2 = tfl5.durable.subscribe(
  { appTid: "a_smoke", resource: "board", key: "k2" },
  {
    webSocket: (url) => {
      calls += 1;
      if (calls === 2) throw new Error("transient factory failure");
      const s = new FakeSocket(url);
      socks2.push(s);
      return s;
    },
  },
);
socks2[0].frame({ type: "welcome", app_tid: "a_smoke", resource: "board", key: "k2", ts: 1 });
socks2[0].onclose?.(); // unexpected drop → reconnect #1 (throws) → back-off retry
await sleep(1100);
assert.equal(calls, 2, "reconnect attempted (and threw)");
assert.notEqual(sub2.status, "closed", "throwing factory did not kill the subscription");
await sleep(2100); // back-off doubled after the failed attempt
assert.equal(calls, 3, "retry re-scheduled after the factory throw");
assert.equal(socks2.length, 2, "third attempt connected");
sub2.close();

// Constructor-time factory errors still surface synchronously to the caller.
assert.throws(
  () =>
    tfl5.durable.subscribe(
      { appTid: "a_smoke", resource: "board", key: "k3" },
      {
        webSocket: () => {
          throw new Error("no transport");
        },
      },
    ),
  /no transport/,
  "first-connect factory error is synchronous",
);

console.log("subscribe-smoke: ALL PASS");
