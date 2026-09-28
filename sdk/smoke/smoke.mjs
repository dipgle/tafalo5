// End-to-end smoke test for @tfl5/sdk against a real dev server.
//
//   TFL5_SMOKE_HOST=http://localhost:8090 node sdk/smoke/smoke.mjs
//
// Requires a running server and a freshly built dist/ (`npm run build`).
// Exercises the client end to end: register → login → app → resource (with a
// level-2 secret field) → doc CRUD → list/where/paging → hooks → shares →
// files → import → auth (QR, signed-out) → identity sharing between two
// users → ownership transfer → site engine → billing/platform reads.
//
// Exit: 0 all passed · 1 a step failed · 2 the run crashed · 3 all passed but
// some steps could not be measured on this server (listed at the end).
//
// Test setup that is NOT part of the SDK contract: new accounts must verify
// their email before writing data. Pass TFL5_SMOKE_VERIFY_CMD (with a {user}
// placeholder) to mark the smoke users verified in the server's database.

import { execSync } from "node:child_process";

import { TFL5, NotFoundError, BadRequestError, PaymentRequiredError, AccessDeniedError } from "../dist/index.js";

const HOST = process.env.TFL5_SMOKE_HOST || "http://localhost:8090";
const stamp = Date.now();
const USER = `sdk_smoke_${stamp}`;
const PASS = `Smoke!${stamp}`;

let pass = 0;
const fails = [];
// Steps this server cannot exercise (a dependency is not configured). Kept
// apart from passes: exit code 3 means "passed, but not everything was measured".
const skipped = [];
function skip(name, reason) {
  skipped.push(`${name} (${reason})`);
  console.log(`  ○ NOT MEASURED: ${name} — ${reason}`);
}
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

async function expectThrows(name, fn, Cls) {
  try {
    await fn();
    ok(name, false, "did not throw");
  } catch (e) {
    ok(name, e instanceof Cls, { name: e?.constructor?.name, code: e?.code });
  }
}

async function main() {
  // cookie mode → exercises the new Node cookie jar (login sets _token).
  const tfl5 = new TFL5({ host: HOST, auth: "cookie" });

  console.log("auth");
  await tfl5.auth.register({
    username: USER,
    password: PASS,
    re_password: PASS,
    email: `${USER}@example.com`,
  });
  ok("register", true);

  // Test setup (NOT part of the SDK contract): data writes are gated on a
  // verified email. Mark the smoke user verified directly. The caller
  // supplies the command via TFL5_SMOKE_VERIFY_CMD with a {user} token,
  // e.g. `docker exec tfl5_pg psql -U tfl5 -d tfl5 -c "..."`.
  const verifyCmd = process.env.TFL5_SMOKE_VERIFY_CMD;
  if (verifyCmd) {
    execSync(verifyCmd.replaceAll("{user}", USER), { stdio: "ignore" });
  }

  const login = await tfl5.auth.login(USER, PASS);
  ok("login returns user", !!login?.user || login?.result === true, login);
  const me = await tfl5.auth.me();
  ok("me() resolves authenticated user", !!me, me);

  console.log("PDPD — data export (non-destructive)");
  const dump = await tfl5.auth.exportData();
  ok(
    "exportData returns self-scoped account",
    dump?.account?.username === USER && /13\/2023/.test(dump?.regulation ?? ""),
    dump,
  );

  console.log("apps");
  const app = await tfl5.apps.create({ name: `Smoke ${stamp}`, description: "sdk smoke" });
  const appTid = app?.tid;
  ok("apps.create returns tid", typeof appTid === "string" && appTid.length > 0, app);
  tfl5.useApp(appTid);
  const list = await tfl5.apps.list();
  ok("apps.list includes the new app", list.some((a) => a.tid === appTid));

  console.log("resource + field-level encryption");
  await tfl5.createResource({
    ma: "person",
    name: "Person",
    fields: [
      { field: "title", validator: "required", level: 0 },
      { field: "national_id", type: "string", level: 2 },
    ],
  });
  ok("createResource", true);
  const person = tfl5.resource("person");
  const created = await person.create({ title: "Alice", national_id: "079123456789" });
  const docTid = created?.tid;
  ok("doc create returns tid", typeof docTid === "string", created);

  const got = await person.get(docTid);
  ok("doc get round-trips level-0 field", got?.data?.title === "Alice", got?.data);
  ok(
    "doc get decrypts level-2 secret field",
    got?.data?.national_id === "079123456789",
    got?.data,
  );

  console.log("list + where (secret field must be unsearchable)");
  const byTitle = await person.list({ where: { title: "Alice" } });
  ok("list where title matches", byTitle.length === 1, { n: byTitle.length });
  // The server REJECTS a filter on an encrypted field (stronger than
  // silently returning nothing) — proves national_id is classified secret.
  await expectThrows(
    "list where secret field is rejected (400)",
    () => person.list({ where: { national_id: "079123456789" } }),
    BadRequestError,
  );

  console.log("update (full replace) + patch (merge convenience)");
  // update replaces data wholesale → must send the full object.
  await person.update(docTid, { title: "Alice 2", national_id: "079123456789" });
  const got2 = await person.get(docTid);
  ok("update applied", got2?.data?.title === "Alice 2", got2?.data);
  ok("update kept secret field (sent in full)", got2?.data?.national_id === "079123456789", got2?.data);
  // patch() = get+merge+update; changing only title keeps national_id.
  await person.patch(docTid, { title: "Alice 3" });
  const got3 = await person.get(docTid);
  ok("patch merged title", got3?.data?.title === "Alice 3", got3?.data);
  ok("patch preserved secret field", got3?.data?.national_id === "079123456789", got3?.data);

  console.log("set_fields hook stamping a SECRET field (MED leak fix, end-to-end)");
  await person.hooks.set([
    {
      id: "stamp_secret",
      on: ["after_create"],
      type: "set_fields",
      params: { set: { national_id: "STAMP-SECRET-42", stamped_public: "ok" } },
    },
  ]);
  const stamped = await person.create({ title: "Bob" });
  const stampedGet = await person.get(stamped.tid);
  ok(
    "hook stamped secret decrypts back",
    stampedGet?.data?.national_id === "STAMP-SECRET-42",
    stampedGet?.data,
  );
  ok("hook stamped public field present", stampedGet?.data?.stamped_public === "ok");
  // The hook-stamped secret was encrypted into data_secret (it decrypts
  // back above) rather than leaked into the searchable index — confirmed
  // by the field still being rejected for filtering (MED leak fix).
  await expectThrows(
    "hook-stamped secret stays classified secret (leak fix)",
    () => person.list({ where: { national_id: "STAMP-SECRET-42" } }),
    BadRequestError,
  );

  console.log("shares");
  const grant = await tfl5.shares.create({ doc_tid: docTid, target: "anonymous", note: "smoke" });
  ok("share create (anonymous) returns token", !!grant?.token || !!grant?.tid, grant);

  console.log("files lifecycle (upload → list → rename → del → trash → restore)");
  // Regression lock: rename/del/restore used to send `{id}` while the server
  // reads `{path, new_path}` / `{path}` / `{file_tid}`, so all three failed on
  // every call.
  const step = async (name, fn, cond) => {
    try {
      const r = await fn();
      ok(name, cond ? await cond(r) : true, r instanceof Blob ? `Blob(${r.size})` : r);
      return r;
    } catch (e) {
      ok(name, false, { code: e?.code, msg: e?.message });
      return undefined;
    }
  };
  const up = await step(
    "files.upload returns the written rows (array)",
    () =>
      tfl5.files.upload(
        { path: "smoke/a.txt", file: new Blob(["hello smoke"]), filename: "a.txt" },
        { stage: "release" },
      ),
    (r) => Array.isArray(r?.files) && r.files[0]?.path === "smoke/a.txt" && r.files[0]?.stage === "release",
  );
  await step(
    "files.list sees the uploaded path",
    () => tfl5.files.list(),
    (r) => Array.isArray(r) && r.some((f) => f.path === "smoke/a.txt"),
  );
  await step("files.rename(path, newPath)", () => tfl5.files.rename("smoke/a.txt", "smoke/b.txt"), (r) => r?.old_path === "smoke/a.txt" && r?.path === "smoke/b.txt");
  await step(
    "files.list sees the renamed path",
    () => tfl5.files.list(),
    (r) => Array.isArray(r) && r.some((f) => f.path === "smoke/b.txt") && !r.some((f) => f.path === "smoke/a.txt"),
  );
  await step("files.del(path) moves to trash", () => tfl5.files.del("smoke/b.txt"), (r) => typeof r?.trashed_at === "number" && r?.is_dir === false);
  const trash = await step(
    "files.trashList shows the deleted file",
    () => tfl5.files.trashList(),
    (r) => Array.isArray(r) && r.some((t) => t.path === "smoke/b.txt"),
  );
  const trashed = Array.isArray(trash) ? trash.find((t) => t.path === "smoke/b.txt") : undefined;
  await step("files.restore(fileTid)", () => tfl5.files.restore(trashed?.tid ?? up?.files?.[0]?.tid ?? "missing"));
  await step(
    "files.list sees the restored file",
    () => tfl5.files.list(),
    (r) => Array.isArray(r) && r.some((f) => f.path === "smoke/b.txt"),
  );

  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const unb64 = (s) => Buffer.from(s ?? "", "base64").toString("utf8");

  console.log("files: save / get / aclSet / purge");
  const meNow = await tfl5.auth.me();
  const myTid = meNow?.user?.tid;
  await step(
    "files.save (base64) to release",
    () => tfl5.files.save({ path: "smoke/c.json", contentBase64: b64('{"a":1}'), stage: "release" }),
    (r) => r?.path === "smoke/c.json" && r?.stage === "release",
  );
  await step("files.get returns the saved bytes", () => tfl5.files.get("smoke/c.json"), (r) => unb64(r?.content_base64) === '{"a":1}');
  await step(
    "files.aclSet stores the readers array",
    () => tfl5.files.aclSet({ path: "smoke/c.json", readers: [myTid] }),
    (r) => Array.isArray(r?.readers) && r.readers.length === 1,
  );
  await step("files.del c.json", () => tfl5.files.del("smoke/c.json"));
  const trash2 = await tfl5.files.trashList().catch(() => []);
  const cRow = trash2.find((t) => t.path === "smoke/c.json");
  await step("files.purge(fileTid)", () => tfl5.files.purge(cRow?.tid ?? "missing"), (r) => r?.tid === cRow?.tid);
  await step(
    "files.trashList no longer shows the purged row",
    () => tfl5.files.trashList(),
    (r) => Array.isArray(r) && !r.some((t) => t.tid === cRow?.tid),
  );

  console.log("docs: keyset paging + CSV import");
  const page1 = await step("resource.listPage(limit 1) returns a cursor", () => person.listPage({ limit: 1 }), (r) => r?.docs?.length === 1 && typeof r?.nextCursor === "string");
  await step(
    "resource.listPage(cursor) returns the next doc",
    () => person.listPage({ limit: 1, cursor: page1?.nextCursor }),
    (r) => r?.docs?.length === 1 && r.docs[0].tid !== page1?.docs?.[0]?.tid,
  );
  const csv = new Blob(["Full name,Code\nCarol,C1\nDave,D2\n"], { type: "text/csv" });
  await step(
    "resources.previewImport infers two fields",
    () => tfl5.resources.previewImport(csv, "people.csv"),
    (r) => Array.isArray(r?.fields) && r.fields.length === 2 && r.total === 2,
  );
  await step(
    "resource.importFile with a mapping imports 2 rows",
    () => person.importFile({ file: csv, filename: "people.csv", mapping: { "Full name": "title" } }),
    (r) => r?.count === 2 && r?.requested === 2,
  );
  await step(
    "resources.constraints lists the resource",
    () => tfl5.resources.constraints(),
    (r) => Array.isArray(r?.resources) && r.resources.some((x) => x.ma === "person"),
  );

  console.log("hook event names (before_del fires; before_delete never did)");
  const guarded = tfl5.resource("guarded");
  await tfl5.resources.create({ ma: "guarded", name: "Guarded", fields: [{ field: "title", level: 0 }] });
  await guarded.hooks.set([
    { id: "old_name", on: ["before_delete"], type: "require_fields", params: { fields: ["approved"] } },
  ]);
  const g1 = await guarded.create({ title: "g1" });
  await step("hook on 'before_delete' does NOT fire (delete goes through)", () => guarded.del(g1.tid));
  await guarded.hooks.set([
    { id: "new_name", on: ["before_del"], type: "require_fields", params: { fields: ["approved"] } },
  ]);
  const g2 = await guarded.create({ title: "g2" });
  try {
    await guarded.del(g2.tid);
    ok("hook on 'before_del' blocks the delete", false, "delete went through");
  } catch (e) {
    ok("hook on 'before_del' blocks the delete", e?.code === "hook_validation_failed", { code: e?.code });
  }
  await step("resource.setResourceAcl after creation", () => guarded.setResourceAcl({ readers: [myTid] }));
  await step(
    "resource.getSchema shows the new readers",
    () => guarded.getSchema(),
    (r) => Array.isArray(r?.readers) && r.readers.includes(myTid),
  );
  await step("resource.destroy() removes the resource", () => guarded.destroy(), (r) => r?.soft_deleted === true);

  console.log("auth: signed-out /user, QR login, phone OTP field names");
  const anon = new TFL5({ host: HOST });
  try {
    await anon.auth.me();
    ok("signed-out auth.me() throws UnauthorizedError", false, "resolved");
  } catch (e) {
    ok("signed-out auth.me() throws UnauthorizedError", e?.constructor?.name === "UnauthorizedError", { name: e?.constructor?.name });
  }
  const qr = await step("auth.qrStart returns session_id", () => anon.auth.qrStart(), (r) => typeof r?.session_id === "string");
  await step("auth.qrPoll(session_id) → pending", () => anon.auth.qrPoll(qr?.session_id), (r) => r?.status === "pending");
  await step("auth.qrReject(session_id)", () => anon.auth.qrReject(qr?.session_id), (r) => r?.rejected === true);
  await step("auth.qrPoll after reject → rejected", () => anon.auth.qrPoll(qr?.session_id), (r) => r?.status === "rejected");
  const desktop = new TFL5({ host: HOST });
  const qr2 = await desktop.auth.qrStart();
  await step("auth.qrApprove from the signed-in phone", () => tfl5.auth.qrApprove(qr2.session_id), (r) => r?.approved === true);
  await step(
    "auth.qrPoll on the desktop → consumed + user",
    () => desktop.auth.qrPoll(qr2.session_id),
    (r) => r?.status === "consumed" && r?.user?.username === USER,
  );
  await step("desktop is now signed in (auth.me)", () => desktop.auth.me(), (r) => r?.user?.username === USER);
  try {
    await anon.auth.phoneVerify("+84900000000", "000000");
    ok("auth.phoneVerify reaches the handler (not a 422)", false, "a bogus code was accepted");
  } catch (e) {
    ok("auth.phoneVerify reaches the handler (not a 422)", e?.status !== 422, { status: e?.status, code: e?.code });
  }

  console.log("second user: identity sharing, member search, ownership transfer");
  const USER2 = `sdk_smoke2_${stamp}`;
  const peer = new TFL5({ host: HOST });
  await peer.auth.register({ username: USER2, password: PASS, re_password: PASS, email: `${USER2}@example.com` });
  if (verifyCmd) execSync(verifyCmd.replaceAll("{user}", USER2), { stdio: "ignore" });
  await peer.auth.login(USER2, PASS);
  const peerTid = (await peer.auth.me())?.user?.tid;
  ok("second user signed in", typeof peerTid === "string");
  await step("identity.set display_name", () => tfl5.identity.set("display_name", "Smoke Owner"));
  await step("identity.get", () => tfl5.identity.get(), (r) => r?.display_name === "Smoke Owner");
  await step("peer cannot see an unshared name", () => peer.identity.resolve({ userTids: [myTid] }), (r) => r?.[0]?.facets?.display_name === undefined);
  const grantId = await step(
    "identity.share with the peer",
    () => tfl5.identity.share({ facet: "display_name", audienceType: "user", audienceRef: peerTid }),
    (r) => typeof r === "number",
  );
  await step("peer now resolves the name", () => peer.identity.resolve({ userTids: [myTid] }), (r) => r?.[0]?.facets?.display_name === "Smoke Owner");
  await step("identity.revoke", () => tfl5.identity.revoke({ grantId }), (r) => r === 1);
  await step("peer loses the name at once", () => peer.identity.resolve({ userTids: [myTid] }), (r) => r?.[0]?.facets?.display_name === undefined);
  await step("identity.accessLog records the peer", () => tfl5.identity.accessLog(), (r) => Array.isArray(r) && r.some((x) => x.viewer_username === USER2));
  await step("apps.searchMembers finds the peer", () => tfl5.apps.searchMembers(USER2), (r) => Array.isArray(r) && r.some((u) => u.username === USER2));

  console.log("site engine: put → publish → rollback");
  await step("site.put index.html", () => tfl5.site.put({ path: "index.html", text: "<h1>v1</h1>" }), (r) => typeof r?.blob_sha === "string");
  await step("site.list shows it", () => tfl5.site.list(), (r) => Array.isArray(r) && r.some((e) => e.path === "index.html"));
  await step("site.get reads it back", () => tfl5.site.get("index.html"), (r) => unb64(r) === "<h1>v1</h1>");
  const live1 = await step("site.publish v1", () => tfl5.site.publish("v1"), (r) => typeof r === "string");
  await tfl5.site.put({ path: "index.html", text: "<h1>v2</h1>" });
  const live2 = await step("site.publish v2", () => tfl5.site.publish("v2"), (r) => typeof r === "string" && r !== live1);
  await step("site.history marks v2 live", () => tfl5.site.history(), (r) => r?.find((s) => s.id === live2)?.is_live === true);
  await step("site.rollback to v1", () => tfl5.site.rollback(live1));
  await step("site.history marks v1 live", () => tfl5.site.history(), (r) => r?.find((s) => s.id === live1)?.is_live === true);
  await step("site.fileHistory lists both versions", () => tfl5.site.fileHistory("index.html"), (r) => Array.isArray(r) && r.length >= 2);
  ok("site.previewUrl builds a URL", tfl5.site.previewUrl().includes(`/app/site/preview?app_tid=${appTid}`));

  console.log("platform / billing / bundle / stages / durable / chat / f3");
  await step("platform.info (GET, no envelope)", () => anon.platform.info(), (r) => r && "google_client_id" in r && Array.isArray(r.google_allowed_origins));
  await step("platform.version", () => anon.platform.version(), (r) => r?.service === "tfl5");
  await step("billing.catalog (GET, public)", () => anon.billing.catalog(), (r) => Array.isArray(r?.services) && typeof r?.money?.minor_units === "number");
  await step("billing.account", () => tfl5.billing.account(), (r) => typeof r?.apps_used === "number");
  await step("billing.credits.balance (Owner)", () => tfl5.billing.credits.balance(), (r) => typeof r === "number");
  await step("billing.credits.packs", () => tfl5.billing.credits.packs(), (r) => Array.isArray(r?.packs));
  await step("billing.services", () => tfl5.billing.services(), (r) => Array.isArray(r));
  try {
    await tfl5.bundle.delete("no-such-version");
    ok("bundle.delete unknown version → bundle_not_found", false, "resolved");
  } catch (e) {
    ok("bundle.delete unknown version → bundle_not_found", e?.code === "bundle_not_found", { code: e?.code });
  }
  const prom = await step(
    "stages.promote queues a job (or answers result:false) without throwing",
    () => tfl5.stages.promote(),
    (r) => r?.result === false || (r?.queued === true && typeof r?.job_id === "string"),
  );
  if (prom?.job_id) {
    let st;
    for (let i = 0; i < 30; i++) {
      st = await tfl5.stages.releaseStatus(prom.job_id);
      if (["succeeded", "failed", "dead", "cancelled"].includes(st?.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok("stages.releaseStatus follows the job to 'succeeded'", st?.status === "succeeded", st);
  }
  await step("stages.releaseStatus(unknown) → result:false, not thrown", () => tfl5.stages.releaseStatus("j-missing"), (r) => r?.result === false);
  try {
    const st = await tfl5.durable.stats({ opId: "counter", instanceKey: "k1" });
    ok("durable.stats on a cold instance → seq -1", st.seq === -1, st);
    await step("durable.grantMail", () => tfl5.durable.grantMail({ senderAppTid: "a-smoke-sender" }), (r) => r?.created === true);
    await step(
      "durable.listMailGrants shows it",
      () => tfl5.durable.listMailGrants(),
      (r) => Array.isArray(r) && r.some((g) => g.senderAppTid === "a-smoke-sender" && g.opId === null),
    );
    await step("durable.revokeMail", () => tfl5.durable.revokeMail({ senderAppTid: "a-smoke-sender" }), (r) => r?.revoked === 1);
  } catch (e) {
    if (e?.code === "durable_disabled") skip("durable.stats", "the durable subsystem is disabled on this server");
    else ok("durable.stats", false, { code: e?.code, msg: e?.message });
  }
  await step("chat.history has the forward cursor", () => tfl5.chat.history({ room: "general" }), (r) => r && "next_after_ts" in r);
  const f3meta = await step(
    "f3.upload an attachment",
    () => tfl5.f3.upload({ app_tid: appTid, doc_tid: docTid, level: 1, name: "note.txt", file: new Blob(["f3 bytes"]) }),
    (r) => typeof r?.f3_tid === "string" || typeof r?.tid === "string",
  );
  await step(
    "f3.download returns the bytes and the filename",
    () => tfl5.f3.download(f3meta?.f3_tid ?? f3meta?.tid),
    async (r) => r?.blob instanceof Blob && (await r.blob.text()) === "f3 bytes" && r.filename === "note.txt" && r.bytes.byteLength === 8,
  );

  console.log("contract fixes: invite / members / account / license / email / shares / scope / release / sources");
  const role = await tfl5.roles.create({ name: `smoke-role-${stamp}` });
  const inv = await step(
    "apps.invite sends role_tids (existing user → user_already_exists)",
    () => tfl5.apps.invite({ email: `${USER2}@example.com`, roleTids: [role.tid] }),
    (r) => r?.status === "user_already_exists" && r?.user_tid === peerTid,
  );
  await step(
    "apps.members returns a page with total",
    () => tfl5.apps.members({ limit: 1 }),
    (r) => Array.isArray(r?.members) && r.members.length <= 1 && typeof r?.total === "number",
  );
  await step("account.profile returns the user object", () => tfl5.account.profile(), (r) => r?.username === USER);
  await step("account.emailList returns an array", () => tfl5.account.emailList(), (r) => Array.isArray(r) && r.length >= 1);
  await step("license.myTokens returns an array", () => tfl5.license.myTokens(), (r) => Array.isArray(r));
  let dkimOk = true;
  try {
    await tfl5.email.dkimCreate({ domain: "example.com" });
  } catch (e) {
    if (/not configured/i.test(e?.message ?? "")) {
      dkimOk = false;
      skip("email.dkimCreate + email.dnsRecords", "the server has no mail service configured");
    } else ok("email.dkimCreate for example.com", false, { code: e?.code, msg: e?.message });
  }
  if (dkimOk) {
    await step(
      "email.dnsRecords returns { records, mail_host }",
      () => tfl5.email.dnsRecords({ domain: "example.com" }),
      (r) => Array.isArray(r?.records) && "mail_host" in r,
    );
  }
  const link = await tfl5.shares.create({ doc_tid: docTid, target: "anonymous" });
  await step(
    "shares.claim(token, appTid) works without sign-in and returns doc_tid",
    () => anon.shares.claim(link.token, appTid),
    (r) => r?.doc_tid === docTid && r?.data?.national_id === undefined,
  );
  await tfl5.access.scopeSet({ field_map: { school: "school_id" } });
  await step(
    "access.scopeSet({ field_map: null }) clears the map",
    () => tfl5.access.scopeSet({ field_map: null }),
    (r) => r?.field_map_size === 0,
  );
  await step(
    "stages.rollbackRelease() swaps back to the previous release",
    () => tfl5.stages.rollbackRelease(),
    (r) => typeof r?.result === "boolean",
  );
  const src2 = await tfl5.sources.register({ name: `smoke-src-${stamp}`, target_resource_ma: "person" });
  await step("sources.rotate returns a new secret", () => tfl5.sources.rotate(src2.tid), (r) => typeof r?.secret === "string" && r.secret !== src2.secret);
  void inv;

  console.log("merged from the 0.1.0 public SDK: capacity error, file warning, chat socket, public forms, durable refusal");
  try {
    await tfl5.apps.create({ name: `Smoke over cap ${stamp}` });
    ok("apps.create over the plan cap throws PaymentRequiredError", false, "resolved");
  } catch (e) {
    ok(
      "apps.create over the plan cap throws PaymentRequiredError",
      e instanceof PaymentRequiredError && e.code === "quota_exceeded" && typeof e.refundableOnDelete === "boolean",
      { name: e?.constructor?.name, code: e?.code, refundable: e?.refundableOnDelete },
    );
  }
  await step(
    "files.save to release under a live site snapshot returns a warning",
    () => tfl5.files.save({ path: "shadowed.txt", contentBase64: b64("x"), stage: "release" }),
    (r) => r?.warnings?.[0]?.code === "file_write_shadowed_by_snapshot",
  );
  const chat = await new Promise((resolve) => {
    const seen = { welcome: null, own: null, errors: [] };
    let sock;
    const timer = setTimeout(() => {
      try { sock?.close(); } catch { /* already closed */ }
      resolve(seen);
    }, 8000);
    sock = tfl5.chat.connect({
      room: "smoke",
      onWelcome: (w) => {
        seen.welcome = w;
        sock.send("hello smoke");
      },
      onMessage: (m) => {
        if (m.text !== "hello smoke") return;
        seen.own = m;
        clearTimeout(timer);
        sock.close();
        resolve(seen);
      },
      onError: (e) => seen.errors.push(e),
    });
  });
  ok("chat.connect from Node carries the session (welcome frame)", chat.welcome?.username === USER, chat);
  ok("chat socket echoes the sender's own message", chat.own?.room === "smoke" && typeof chat.own?.tid === "string", chat);
  await step("chat.history shows the socket message", () => tfl5.chat.history({ room: "smoke" }), (r) => r?.messages?.some((m) => m.text === "hello smoke"));
  await step("chat.setRoomConfig", () => tfl5.chat.setRoomConfig({ room: "smoke", min_level: "Editor" }), (r) => r?.min_level === "Editor");
  await step("chat.getRoomConfig", () => tfl5.chat.getRoomConfig({ room: "smoke" }), (r) => r?.configured === true && r?.min_level === "Editor");
  await step("chat.removeRoomConfig", () => tfl5.chat.removeRoomConfig({ room: "smoke" }), (r) => r?.removed === true);
  try {
    tfl5.chat.setRoomConfig({ room: "smoke", min_level: null });
    ok("chat.setRoomConfig with nothing to set is refused before the request", false, "sent");
  } catch (e) {
    ok("chat.setRoomConfig with nothing to set is refused before the request", /min_level and\/or scope_attrs/.test(e?.message ?? ""));
  }
  await step(
    "publicForms.setConfig",
    () => tfl5.publicForms.setConfig("contact", { fields: { email: { type: "email", required: true }, msg: {} } }),
    (r) => r?.form_id === "contact",
  );
  await step("publicForms.getConfig(formId)", () => tfl5.publicForms.getConfig("contact"), (r) => r?.configured === true);
  await step(
    "publicForm.submit without sign-in",
    () => anon.publicForm.submit({ app_tid: appTid, form_id: "contact", fields: { email: "a@example.com", msg: "hi" } }),
    (r) => typeof r?.submission_tid === "string",
  );
  await step(
    "publicForms.list shows the submission",
    () => tfl5.publicForms.list({ form_id: "contact" }),
    (r) => Array.isArray(r?.submissions) && r.submissions.some((s) => s.fields?.msg === "hi"),
  );
  try {
    await peer.durable.send({ appTid, opId: "counter", instanceKey: "k1", msg: {} });
    ok("durable.send by a non-member throws AccessDeniedError", false, "resolved");
  } catch (e) {
    ok("durable.send by a non-member throws AccessDeniedError", e instanceof AccessDeniedError, { name: e?.constructor?.name, code: e?.code });
  }
  await step("scope.get (0.1.0 name) works", () => tfl5.scope.get(), (r) => r && "field_map" in r);
  ok("bundles/domains/publicForms are aliases", tfl5.bundles === tfl5.bundle && tfl5.domains === tfl5.domain && tfl5.publicForms === tfl5.publicForm);

  // Last, because it changes who owns the smoke app. (The demo plan allows
  // one app per user, so the smoke cannot create a second one to hand over.)
  console.log("ownership transfer");
  await step(
    "apps.transferOwnership(new_owner_tid, keepOldAsManager)",
    () => tfl5.apps.transferOwnership(appTid, peerTid, { keepOldAsManager: true }),
  );
  await step("the new owner sees the app", () => peer.apps.list(), (r) => Array.isArray(r) && r.some((a) => a.tid === appTid));

  console.log("error mapping");
  try {
    await person.get("d-does-not-exist");
    ok("not-found throws", false, "no throw");
  } catch (e) {
    ok("not-found throws NotFoundError", e instanceof NotFoundError, {
      name: e?.constructor?.name,
      code: e?.code,
    });
  }

  console.log("new clients (SDK expansion): access / scope / license / account / email / bundle / domain / audit");
  const okCall = async (name, fn, cond) => {
    try {
      const r = await fn();
      ok(name, cond ? cond(r) : r !== undefined, r);
    } catch (e) {
      ok(name, false, e?.message || String(e));
    }
  };
  await okCall("access.aclList → buckets", () => tfl5.access.aclList(), (r) => r && Array.isArray(r.managers));
  await okCall("access.scopeGet → field_map", () => tfl5.access.scopeGet(), (r) => r && typeof r.field_map === "object");
  await okCall("license.catalog → tiers", () => tfl5.license.catalog());
  // /user/* endpoints return `{result, user}` (not the {result,data} envelope),
  // so http passes the whole body through and the user is under `.user`.
  await okCall("account.profile → user", () => tfl5.account.profile(), (r) => !!(r && r.username));
  await okCall("email.dkimList", () => tfl5.email.dkimList());
  await okCall("bundle.list", () => tfl5.bundle.list());
  await okCall("domain.list", () => tfl5.domain.list());
  await okCall("audit.list", () => tfl5.audit.list());

  console.log(`\n${pass} passed, ${fails.length} failed, ${skipped.length} not measured`);
  if (fails.length) {
    console.log("FAILED:", fails.join(", "));
    process.exit(1);
  }
  if (skipped.length) {
    console.log("NOT MEASURED:", skipped.join("; "));
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e?.stack || e);
  process.exit(2);
});
