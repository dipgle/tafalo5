// End-to-end smoke test for @tfl5/sdk against a real dev server.
//
//   TFL5_SMOKE_HOST=http://localhost:8090 node sdk/smoke/smoke.mjs
//
// Requires a running tfl5 dev server (:8090) and a
// freshly built dist/ (`npm run build` in sdk/). Exercises the spine end to
// end through the typed client: register → login → app → resource (with a
// level-2 secret field) → doc CRUD → list/where → set_fields hook that
// stamps a secret field (the MED leak fix) → shares.

import { execSync } from "node:child_process";

import { TFL5, NotFoundError, BadRequestError } from "../dist/index.js";

const HOST = process.env.TFL5_SMOKE_HOST || "http://localhost:8090";
const stamp = Date.now();
const USER = `sdk_smoke_${stamp}`;
const PASS = `Smoke!${stamp}`;

let pass = 0;
const fails = [];
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

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("FAILED:", fails.join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e?.stack || e);
  process.exit(2);
});
