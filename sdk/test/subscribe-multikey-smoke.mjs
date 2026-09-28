// Smoke for MULTI-KEY DurableSubscription frame handling — runs the COMPILED
// dist artifact with an injected fake WebSocket factory (no network), covering:
// input validation (key/keys exclusivity, 1..=16, first-wins dedupe), repeated
// key= URL params, welcome keys-echo mismatch surfacing, per-key snapshots
// ("live" only after ALL keys snapshotted), key-attributed delta routing
// (same instance independent across keys; stale dropped per key), unsubscribed
// / key-less frames surfaced-and-dropped, key-attributed heartbeat with
// per-key behind-detection + the pending-snapshot guard after reconnect, and
// per-key lagged recovery (only that key's rows replaced).
//
//   cd sdk && npm run build && node test/subscribe-multikey-smoke.mjs
//
// Exit 0 = all assertions passed.

import assert from "node:assert/strict";
import { TFL5, SUBSCRIBE_KEYS_MAX } from "../dist/index.js";

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

const tfl5 = new TFL5({ host: "http://cell.example", auth: "bearer" });

// --- Input validation throws synchronously (server refuses pre-upgrade,
// --- which a browser only shows as a silent failed connection). -----------
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", resource: "board", key: "k1", keys: ["k2"] }),
  /not both/,
  "key and keys are mutually exclusive",
);
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", resource: "board", keys: [] }),
  /at least one key/,
  "empty keys refused",
);
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", resource: "board" }),
  /at least one key/,
  "neither key nor keys refused",
);
assert.equal(SUBSCRIBE_KEYS_MAX, 16, "cap mirrors the server const");
assert.throws(
  () =>
    tfl5.durable.subscribe({
      appTid: "a",
      resource: "board",
      keys: Array.from({ length: 17 }, (_, i) => `k${i}`),
    }),
  /at most 16/,
  "over-cap keys refused client-side",
);

// --- Main multi-key lifecycle. duplicate k1 collapses first-wins (mirror of
// --- the server's parse) so the socket carries [k1, k2]. -------------------
const sockets = [];
const updates = []; // {key, rows} per onUpdate
const statuses = [];
const errors = [];
const sub = tfl5.durable.subscribe(
  { appTid: "a_smoke", resource: "board", keys: ["k1", "k2", "k1"] },
  {
    webSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onUpdate: (rows, key) => updates.push({ key, rows }),
    onStatus: (st) => statuses.push(st),
    onError: (e) => errors.push(e),
  },
);
const s1 = sockets[0];
assert.equal(
  s1.url,
  "ws://cell.example/ws/durable/subscribe?app_tid=a_smoke&resource=board&key=k1&key=k2",
  "repeated key= params, deduped first-wins",
);

// Welcome echoes the parsed key list; a matching echo is silent.
s1.frame({
  type: "welcome",
  app_tid: "a_smoke",
  resource: "board",
  keys: ["k1", "k2"],
  ts: 1,
});
assert.equal(errors.length, 0, "matching keys echo is not an error");

// live ONLY after ALL keys have their snapshot — 1 of 2 is not a usable view.
s1.frame({
  type: "snapshot",
  key: "k1",
  rows: [{ instance_tid: "di_a", seq: 1, doc: { n: 1 } }],
  ts: 2,
});
assert.equal(sub.status, "connecting", "half-snapshotted socket is not live");
assert.deepEqual(updates.at(-1).key, "k1", "onUpdate names the applied key");
s1.frame({
  type: "snapshot",
  key: "k2",
  rows: [{ instance_tid: "di_a", seq: 5, doc: { n: 50 } }],
  ts: 3,
});
assert.equal(sub.status, "live", "all keys snapshotted flips to live");

// The same instance projects independently under each key.
assert.equal(sub.get("di_a", "k1").seq, 1);
assert.equal(sub.get("di_a", "k2").seq, 5);
assert.throws(
  () => sub.get("di_a"),
  /ambiguous/,
  "key-less get() refused on a multi-key subscription",
);
assert.deepEqual(
  sub.rows().map((r) => [r.key, r.instanceTid, r.seq]),
  [
    ["k1", "di_a", 1],
    ["k2", "di_a", 5],
  ],
  "rows() spans all keys, sorted by (key, instanceTid)",
);
assert.deepEqual(
  sub.rows("k2").map((r) => [r.key, r.seq]),
  [["k2", 5]],
  "rows(key) scopes to one key",
);

// Delta routes by its key tag: k1 advances, k2 untouched.
s1.frame({ type: "delta", key: "k1", instance_tid: "di_a", seq: 2, doc: { n: 2 }, ts: 4 });
assert.equal(sub.get("di_a", "k1").seq, 2, "tagged delta applied to its key");
assert.equal(sub.get("di_a", "k2").seq, 5, "sibling key untouched");
assert.equal(updates.at(-1).key, "k1");
// Stale delta judged against ITS key's held seq.
s1.frame({ type: "delta", key: "k2", instance_tid: "di_a", seq: 4, doc: { n: 99 }, ts: 5 });
assert.equal(sub.get("di_a", "k2").doc.n, 50, "stale delta dropped per-key");

// Anomalous frames are surfaced (never silently misfiled) and dropped.
const before = updates.length;
s1.frame({ type: "delta", key: "kX", instance_tid: "di_z", seq: 9, doc: {}, ts: 6 });
assert.equal(errors.at(-1).code, "bad_frame", "unsubscribed key surfaced");
assert.equal(errors.at(-1).key, "kX");
s1.frame({ type: "delta", instance_tid: "di_z", seq: 9, doc: {}, ts: 7 });
assert.equal(errors.at(-1).code, "bad_frame", "key-less frame on multi-key surfaced");
assert.equal(updates.length, before, "neither anomalous frame applied");
assert.equal(sub.rows().length, 2, "state untouched by dropped frames");

// In-sync key-attributed heartbeat is a no-op.
s1.frame({
  type: "heartbeat",
  rows: [
    { instance_tid: "di_a", seq: 2, key: "k1" },
    { instance_tid: "di_a", seq: 5, key: "k2" },
  ],
  ts: 8,
});
await sleep(1100);
assert.equal(sub.status, "live", "in-sync heartbeat is a no-op");
assert.equal(s1.closeCalls.length, 0);

// Per-key lagged recovery: the error names the key; the follow-up snapshot
// replaces ONLY that key's rows.
s1.frame({ type: "error", code: "lagged", key: "k2", msg: "1 deltas dropped", ts: 9 });
assert.equal(errors.at(-1).code, "lagged");
assert.equal(errors.at(-1).key, "k2", "lagged error carries the affected key");
s1.frame({
  type: "snapshot",
  key: "k2",
  rows: [{ instance_tid: "di_b", seq: 7, doc: { n: 70 } }],
  ts: 10,
});
assert.deepEqual(
  sub.rows("k2").map((r) => [r.instanceTid, r.seq]),
  [["di_b", 7]],
  "lagged key's snapshot replaced that key (di_a gone from k2)",
);
assert.deepEqual(
  sub.rows("k1").map((r) => [r.instanceTid, r.seq]),
  [["di_a", 2]],
  "sibling key survived the other key's recovery",
);
assert.equal(sub.status, "live", "mid-stream recovery does not drop live");

// Behind on ONE key (k2 seq ahead) → grace passes with no catch-up → resync.
s1.frame({
  type: "heartbeat",
  rows: [
    { instance_tid: "di_a", seq: 2, key: "k1" },
    { instance_tid: "di_b", seq: 9, key: "k2" },
  ],
  ts: 11,
});
assert.equal(s1.closeCalls.length, 0, "resync deferred to the grace re-check");
await sleep(1100);
assert.ok(statuses.includes("behind"), "one behind key flags the socket behind");
assert.equal(s1.closeCalls.length, 1, "resync closes the socket");

// Reconnect refills pendingSnapshots: not live until BOTH keys re-snapshot,
// and a heartbeat about a still-pending key must NOT re-trigger behind (its
// snapshot is in flight and supersedes the heartbeat).
await sleep(1100);
assert.equal(sockets.length, 2, "resync reconnected");
const s2 = sockets[1];
s2.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", keys: ["k1", "k2"], ts: 12 });
s2.frame({
  type: "snapshot",
  key: "k1",
  rows: [{ instance_tid: "di_a", seq: 2, doc: { n: 2 } }],
  ts: 13,
});
assert.equal(sub.status, "connecting", "reconnect re-earns live per key");
s2.frame({ type: "heartbeat", rows: [{ instance_tid: "di_b", seq: 9, key: "k2" }], ts: 14 });
await sleep(1100);
assert.equal(sub.status, "connecting", "pending-snapshot key exempt from behind-detect");
assert.equal(s2.closeCalls.length, 0, "no resync loop while the snapshot is in flight");
s2.frame({
  type: "snapshot",
  key: "k2",
  rows: [{ instance_tid: "di_b", seq: 9, doc: { n: 90 } }],
  ts: 15,
});
assert.equal(sub.status, "live", "second snapshot completes the reconnect");
assert.equal(sub.get("di_b", "k2").seq, 9, "recovered to the heartbeat's seq");
sub.close();
assert.equal(sub.status, "closed");

// --- Welcome keys-echo mismatch is surfaced (version-skew tripwire). -------
{
  const socks = [];
  const errs = [];
  const sub2 = tfl5.durable.subscribe(
    { appTid: "a_smoke", resource: "board", keys: ["a", "b"] },
    {
      webSocket: (url) => {
        const s = new FakeSocket(url);
        socks.push(s);
        return s;
      },
      onError: (e) => errs.push(e),
    },
  );
  socks[0].frame({ type: "welcome", app_tid: "a_smoke", resource: "board", keys: ["a"], ts: 1 });
  assert.equal(errs.at(-1)?.code, "keys_mismatch", "short echo surfaced");
  sub2.close();
}

// --- keys:["only"] behaves exactly like key:"only" — key-less (pre-multi-key
// --- server) frames fall back to the sole key; key-less get() works. -------
{
  const socks = [];
  const sub3 = tfl5.durable.subscribe(
    { appTid: "a_smoke", resource: "board", keys: ["only"] },
    {
      webSocket: (url) => {
        const s = new FakeSocket(url);
        socks.push(s);
        return s;
      },
    },
  );
  assert.ok(socks[0].url.endsWith("key=only"), "single-element keys builds a single key=");
  socks[0].frame({ type: "welcome", app_tid: "a_smoke", resource: "board", key: "only", ts: 1 });
  socks[0].frame({
    type: "snapshot",
    rows: [{ instance_tid: "di_a", seq: 1, doc: { n: 1 } }],
    ts: 2,
  });
  assert.equal(sub3.status, "live", "key-less snapshot lands on the sole key");
  socks[0].frame({ type: "delta", instance_tid: "di_a", seq: 2, doc: { n: 2 }, ts: 3 });
  assert.equal(sub3.get("di_a").seq, 2, "key-less delta + key-less get() on the sole key");
  assert.equal(sub3.get("di_a").key, "only", "rows carry the resolved key");
  socks[0].frame({ type: "heartbeat", rows: [{ instance_tid: "di_a", seq: 2 }], ts: 4 });
  await sleep(1100);
  assert.equal(sub3.status, "live", "key-less in-sync heartbeat is a no-op");
  assert.equal(socks[0].closeCalls.length, 0);
  sub3.close();
}

// --- P1 regression lock: a failed JOIN read must self-heal. The server
// --- keeps the socket open after a failed snapshot read and sends a
// --- key-less error{read_failed} — without a resync, the key sits in
// --- pendingSnapshots forever: never "live", exempt from behind-detect. ----
{
  const socks = [];
  const errs = [];
  const sub5 = tfl5.durable.subscribe(
    { appTid: "a_smoke", resource: "board", keys: ["k1", "k2"] },
    {
      webSocket: (url) => {
        const s = new FakeSocket(url);
        socks.push(s);
        return s;
      },
      onError: (e) => errs.push(e),
    },
  );
  const a = socks[0];
  a.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", keys: ["k1", "k2"], ts: 1 });
  a.frame({
    type: "snapshot",
    key: "k1",
    rows: [{ instance_tid: "di_a", seq: 1, doc: { n: 1 } }],
    ts: 2,
  });
  a.frame({ type: "error", code: "read_failed", msg: "snapshot read failed", ts: 3 });
  assert.equal(errs.at(-1).code, "read_failed", "failure surfaced");
  assert.equal(a.closeCalls.length, 1, "read_failed with a snapshot pending resyncs");
  await sleep(1100); // first retry at the back-off floor (1s)
  assert.equal(socks.length, 2, "reconnected for a fresh snapshot attempt");
  // Server still broken → back-off must GROW (no floor-delay hammering):
  // welcome does NOT reset attempts; only reaching "live" does.
  const b = socks[1];
  b.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", keys: ["k1", "k2"], ts: 4 });
  b.frame({ type: "error", code: "read_failed", msg: "snapshot read failed", ts: 5 });
  assert.equal(b.closeCalls.length, 1, "second failed join read resyncs again");
  await sleep(1100);
  assert.equal(socks.length, 2, "back-off doubled — no reconnect after only 1s");
  await sleep(1100);
  assert.equal(socks.length, 3, "second reconnect after the doubled delay");
  // Server recovered → full join → live, back-off re-earned.
  const c = socks[2];
  c.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", keys: ["k1", "k2"], ts: 6 });
  c.frame({
    type: "snapshot",
    key: "k1",
    rows: [{ instance_tid: "di_a", seq: 1, doc: { n: 1 } }],
    ts: 7,
  });
  c.frame({ type: "snapshot", key: "k2", rows: [], ts: 8 });
  assert.equal(sub5.status, "live", "self-heal recovered live after the failed join reads");
  // A mid-stream (post-live) read_failed is NOT a join failure — the
  // heartbeat seq check owns that recovery; no resync fires.
  c.frame({ type: "error", code: "read_failed", msg: "delta re-read failed", ts: 9 });
  assert.equal(c.closeCalls.length, 0, "post-live read_failed does not resync");
  sub5.close();
}

// --- Keyed read_failed routing (server now tags the key when known): a
// --- live key's delta re-read failure must NOT resync a socket that is
// --- still assembling OTHER keys' snapshots; a keyed JOIN failure (the
// --- pending key itself) must. ---------------------------------------------
{
  const socks = [];
  const errs = [];
  const sub7 = tfl5.durable.subscribe(
    { appTid: "a_smoke", resource: "board", keys: ["p1", "p2"] },
    {
      webSocket: (url) => {
        const s = new FakeSocket(url);
        socks.push(s);
        return s;
      },
      onError: (e) => errs.push(e),
    },
  );
  const a = socks[0];
  a.frame({ type: "welcome", app_tid: "a_smoke", resource: "board", keys: ["p1", "p2"], ts: 1 });
  a.frame({
    type: "snapshot",
    key: "p1",
    rows: [{ instance_tid: "di_a", seq: 1, doc: { n: 1 } }],
    ts: 2,
  });
  // p1 snapshotted, p2 still pending. A keyed read_failed for p1 is a
  // mid-stream delta re-read hiccup — NOT a join failure. No resync.
  a.frame({ type: "error", code: "read_failed", key: "p1", msg: "delta re-read failed", ts: 3 });
  assert.equal(errs.at(-1).key, "p1", "keyed error surfaced");
  assert.equal(a.closeCalls.length, 0, "live key's read_failed does not resync mid-join");
  // A keyed read_failed for p2 — the key whose snapshot IS pending — is a
  // join failure: that snapshot is not coming. Resync.
  a.frame({ type: "error", code: "read_failed", key: "p2", msg: "snapshot read failed", ts: 4 });
  assert.equal(a.closeCalls.length, 1, "pending key's keyed read_failed resyncs");
  sub7.close();
}

// Single-key back-compat: the old client recovered a failed join read via the
// next heartbeat; the pending-key exemption must not have lost that.
{
  const socks = [];
  const sub6 = tfl5.durable.subscribe(
    { appTid: "a_smoke", resource: "board", key: "k9" },
    {
      webSocket: (url) => {
        const s = new FakeSocket(url);
        socks.push(s);
        return s;
      },
    },
  );
  socks[0].frame({ type: "welcome", app_tid: "a_smoke", resource: "board", key: "k9", ts: 1 });
  socks[0].frame({ type: "error", code: "read_failed", msg: "snapshot read failed", ts: 2 });
  assert.equal(
    socks[0].closeCalls.length,
    1,
    "single-key failed join read resyncs (pre-multi-key self-heal preserved)",
  );
  sub6.close();
}

console.log("subscribe-multikey-smoke: ALL PASS");
