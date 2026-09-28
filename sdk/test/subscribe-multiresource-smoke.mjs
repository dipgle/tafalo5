// Smoke for MULTI-RESOURCE DurableSubscription — runs the COMPILED dist
// artifact with an injected fake WebSocket factory (no network), covering:
//
//   - Input validation: subs form mutually exclusive with resource/key/keys;
//     subs must be non-empty; over-cap refused; duplicates collapse first-wins.
//   - URL: multi-resource form emits repeated rk=<resource>%1F<key> params
//     (U+001F encoded as %1F by URLSearchParams.append).
//   - Welcome: server echoes `subs` list; mismatch surfaces as subs_mismatch.
//   - Snapshots: one per (resource, key) in subscribe order; "live" only after
//     ALL pairs snapshotted; per-(resource,key) pending guard.
//   - Deltas: same key under different resources routes to the correct slot;
//     cross-resource contamination impossible (bySub keyed by resource+key).
//   - ProjectionRow carries `resource` field.
//   - rows(resource, key) scopes to the specific pair.
//   - rows(key) still works when all subs share one resource.
//   - get(tid, resource, key) full form works.
//   - get(tid, key) throws on multi-resource sockets.
//   - Heartbeat: rows with resource+key attributed correctly; behind-detection
//     per (resource, key) pair.
//   - error frames carry resource field; read_failed resync by (resource,key).
//   - Back-compat: old single-resource `resource=+key=` URL form still emitted
//     when using the resource+key input form.
//   - Legacy welcome (keys echo, no subs) handled gracefully.
//
//   cd sdk && npm run build && node test/subscribe-multiresource-smoke.mjs
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
    queueMicrotask(() => this.onclose?.());
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tfl5 = new TFL5({ host: "http://cell.example", auth: "bearer" });

// ---------------------------------------------------------------------------
// --- Input validation: subs form -----------------------------------------
// ---------------------------------------------------------------------------
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", resource: "board", subs: [{ resource: "x", key: "k" }] }),
  /not both/,
  "subs is mutually exclusive with resource",
);
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", subs: [{ resource: "x", key: "k" }], key: "k" }),
  /mutually exclusive/,
  "subs is mutually exclusive with key",
);
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", subs: [] }),
  /at least one key/,
  "empty subs refused",
);
assert.throws(
  () => tfl5.durable.subscribe({ appTid: "a", subs: Array.from({ length: 17 }, (_, i) => ({ resource: "r", key: `k${i}` })) }),
  /at most 16/,
  "over-cap subs refused",
);

// Duplicate (resource, key) pairs collapse first-wins.
const sockets = [];
const updates = [];
const statuses = [];
const errors = [];
const sub = tfl5.durable.subscribe(
  {
    appTid: "a_mr",
    subs: [
      { resource: "board", key: "k1" },
      { resource: "scores", key: "k1" }, // same key, different resource
      { resource: "board", key: "k1" },  // dup — collapsed
    ],
  },
  {
    webSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onUpdate: (rows, key, resource) => updates.push({ resource, key, rows: rows.map((r) => ({ resource: r.resource, key: r.key, tid: r.instanceTid, seq: r.seq })) }),
    onStatus: (st) => statuses.push(st),
    onError: (e) => errors.push(e),
  },
);
const s1 = sockets[0];

// Only 2 unique pairs after dedup.
assert.ok(s1.url.includes("rk=board%1Fk1"), "URL contains board rk param");
assert.ok(s1.url.includes("rk=scores%1Fk1"), "URL contains scores rk param");
// Duplicate should NOT appear twice.
const rkCount = (s1.url.match(/rk=/g) ?? []).length;
assert.equal(rkCount, 2, "duplicate rk pair collapsed to 2 unique params");
// Not the legacy resource= form.
assert.ok(!s1.url.includes("resource="), "multi-resource URL must not use resource= form");

// ---------------------------------------------------------------------------
// --- Welcome: subs echo ---------------------------------------------------
// ---------------------------------------------------------------------------
assert.equal(sub.status, "connecting", "initially connecting");

s1.frame({
  type: "welcome",
  app_tid: "a_mr",
  subs: [{ resource: "board", key: "k1" }, { resource: "scores", key: "k1" }],
  ts: 1,
});
// No subs_mismatch (echo matches).
assert.equal(errors.filter((e) => e.code === "subs_mismatch").length, 0, "welcome echo matches");
assert.equal(sub.status, "connecting", "still connecting (snapshots not all in)");

// Welcome with mismatched subs echo surfaces error.
const errsBefore = errors.length;
s1.frame({
  type: "welcome",
  app_tid: "a_mr",
  subs: [{ resource: "board", key: "k1" }], // missing scores — mismatch
  ts: 1,
});
assert.ok(
  errors.slice(errsBefore).some((e) => e.code === "subs_mismatch"),
  "subs_mismatch surfaced on echo mismatch",
);

// ---------------------------------------------------------------------------
// --- Snapshots: one per (resource, key) in subscribe order ----------------
// ---------------------------------------------------------------------------
// First snapshot for board/k1 — not yet live.
s1.frame({ type: "snapshot", resource: "board", key: "k1", rows: [{ instance_tid: "di_a", seq: 0, doc: { n: 1 } }], ts: 2 });
assert.equal(sub.status, "connecting", "still connecting: scores/k1 snapshot pending");
assert.equal(updates.length, 1, "onUpdate fired after first snapshot");
assert.deepEqual(
  sub.rows("board", "k1").map((r) => [r.instanceTid, r.seq]),
  [["di_a", 0]],
  "rows(resource, key) scopes to board/k1",
);
assert.deepEqual(sub.rows("scores", "k1"), [], "scores/k1 empty until its snapshot");

// Second snapshot for scores/k1 — now live.
s1.frame({ type: "snapshot", resource: "scores", key: "k1", rows: [{ instance_tid: "di_b", seq: 0, doc: { score: 10 } }], ts: 3 });
assert.equal(sub.status, "live", "live after all pairs snapshotted");
assert.equal(updates.length, 2, "onUpdate fired after second snapshot");

// ProjectionRow carries resource field.
const boardRows = sub.rows("board", "k1");
assert.equal(boardRows.length, 1);
assert.equal(boardRows[0]?.resource, "board", "ProjectionRow.resource = board");
assert.equal(boardRows[0]?.key, "k1", "ProjectionRow.key = k1");

const scoresRows = sub.rows("scores", "k1");
assert.equal(scoresRows.length, 1);
assert.equal(scoresRows[0]?.resource, "scores", "ProjectionRow.resource = scores");

// rows() across all — sorted by (resource, key, instanceTid).
const allRows = sub.rows();
assert.equal(allRows.length, 2, "rows() spans all pairs");
assert.deepEqual(
  allRows.map((r) => [r.resource, r.key, r.instanceTid]),
  [["board", "k1", "di_a"], ["scores", "k1", "di_b"]],
  "rows() sorted by (resource, key, instanceTid)",
);

// ---------------------------------------------------------------------------
// --- get(tid, resource, key) full form ------------------------------------
// ---------------------------------------------------------------------------
assert.equal(sub.get("di_a", "board", "k1")?.seq, 0, "get(tid, resource, key) works");
assert.equal(sub.get("di_b", "scores", "k1")?.seq, 0, "get(tid, resource, key) works");
assert.equal(sub.get("di_a", "scores", "k1"), undefined, "wrong resource returns undefined");

// get(tid, key) throws on multi-resource sockets.
assert.throws(
  () => sub.get("di_a", "k1"),
  /multi-resource/,
  "get(tid, key) throws on multi-resource subscription",
);

// ---------------------------------------------------------------------------
// --- Deltas: same key, different resource, routed independently -----------
// ---------------------------------------------------------------------------
// Delta for board/k1 — must NOT affect scores/k1.
s1.frame({
  type: "delta",
  resource: "board",
  key: "k1",
  instance_tid: "di_a",
  seq: 1,
  doc: { n: 2 },
  ts: 4,
});
assert.equal(sub.get("di_a", "board", "k1")?.seq, 1, "board/k1 delta applied");
assert.equal(sub.get("di_b", "scores", "k1")?.seq, 0, "scores/k1 unaffected");
assert.equal(updates[updates.length - 1]?.resource, "board", "onUpdate carries resource");
assert.equal(updates[updates.length - 1]?.key, "k1", "onUpdate carries key");

// Delta for scores/k1 — must NOT affect board/k1.
s1.frame({
  type: "delta",
  resource: "scores",
  key: "k1",
  instance_tid: "di_b",
  seq: 1,
  doc: { score: 20 },
  ts: 5,
});
assert.equal(sub.get("di_b", "scores", "k1")?.seq, 1, "scores/k1 delta applied");
assert.equal(sub.get("di_a", "board", "k1")?.seq, 1, "board/k1 still unaffected");

// ---------------------------------------------------------------------------
// --- Heartbeat: (resource, key, instance) attributed ---------------------
// ---------------------------------------------------------------------------
s1.frame({
  type: "heartbeat",
  rows: [
    { resource: "board", key: "k1", instance_tid: "di_a", seq: 1 },
    { resource: "scores", key: "k1", instance_tid: "di_b", seq: 1 },
  ],
  ts: 6,
});
// Not behind (seq matches local).
assert.ok(!statuses.includes("behind"), "not behind when seq matches");

// Behind on scores/k1 only.
s1.frame({
  type: "heartbeat",
  rows: [
    { resource: "board", key: "k1", instance_tid: "di_a", seq: 1 },
    { resource: "scores", key: "k1", instance_tid: "di_b", seq: 5 }, // ahead
  ],
  ts: 7,
});
assert.equal(s1.closeCalls.length, 0, "resync deferred to grace re-check");
await sleep(1100);
assert.ok(statuses.includes("behind"), "behind when one pair's seq is ahead");
assert.equal(s1.closeCalls.length, 1, "resync closes the socket");

// ---------------------------------------------------------------------------
// --- error frames: resource attributed -----------------------------------
// ---------------------------------------------------------------------------
await sleep(1100); // reconnect
const s2 = sockets[1];
assert.ok(s2 !== undefined, "reconnected after resync");

// Serve snapshots to get back to live.
s2.frame({ type: "welcome", app_tid: "a_mr", subs: [{ resource: "board", key: "k1" }, { resource: "scores", key: "k1" }], ts: 8 });
s2.frame({ type: "snapshot", resource: "board", key: "k1", rows: [{ instance_tid: "di_a", seq: 1, doc: { n: 2 } }], ts: 9 });
s2.frame({ type: "snapshot", resource: "scores", key: "k1", rows: [{ instance_tid: "di_b", seq: 5, doc: { score: 50 } }], ts: 10 });
assert.equal(sub.status, "live", "live after re-snapshot on reconnect");

// read_failed with (resource, key) — fully attributed resync only if pending.
const errsBefore2 = errors.length;
s2.frame({
  type: "error",
  code: "read_failed",
  resource: "board",
  key: "k1",
  msg: "simulated read fail",
  ts: 11,
});
const readFailErr = errors.slice(errsBefore2).find((e) => e.code === "read_failed");
assert.ok(readFailErr !== undefined, "read_failed error surfaced");
assert.equal(readFailErr.resource, "board", "error carries resource");
assert.equal(readFailErr.key, "k1", "error carries key");
// Not pending (already live) → no resync.
assert.equal(s2.closeCalls.length, 0, "post-live read_failed must not trigger resync");

// ---------------------------------------------------------------------------
// --- Back-compat: single-resource input still emits resource= form -------
// ---------------------------------------------------------------------------
const bcSockets = [];
const bcSub = tfl5.durable.subscribe(
  { appTid: "a_bc", resource: "board", keys: ["a", "b"] },
  { webSocket: (url) => { const s = new FakeSocket(url); bcSockets.push(s); return s; } },
);
const bcS = bcSockets[0];
assert.ok(bcS !== undefined, "back-compat socket created");
assert.ok(bcS.url.includes("resource=board"), "single-resource URL uses resource= form");
assert.ok(bcS.url.includes("key=a"), "single-resource URL uses key= form");
assert.ok(bcS.url.includes("key=b"), "single-resource URL uses key= form");
assert.ok(!bcS.url.includes("rk="), "single-resource URL must not use rk= form");
bcSub.close();

// Legacy welcome (keys echo, no subs) handled gracefully.
const legacyErrors = [];
const legacySockets = [];
const legacySub = tfl5.durable.subscribe(
  { appTid: "a_lg", resource: "board", key: "k1" },
  {
    webSocket: (url) => { const s = new FakeSocket(url); legacySockets.push(s); return s; },
    onError: (e) => legacyErrors.push(e),
  },
);
const legS = legacySockets[0];
legS.frame({ type: "welcome", app_tid: "a_lg", resource: "board", keys: ["k1"], ts: 1 });
assert.equal(legacyErrors.filter((e) => e.code === "keys_mismatch").length, 0, "legacy welcome (keys echo) no error");
legacySub.close();

sub.close();

console.log("subscribe-multiresource-smoke: ALL PASS");
