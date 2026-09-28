// Browser smoke: the classic-script build a Tafalo server serves at /sdk.js,
// driven inside a real Chromium page on the server's own origin (so the
// session lives in the browser's cookie store, as it does for real apps).
//
//   TFL5_SMOKE_HOST=http://localhost:8090 TFL5_SMOKE_VERIFY_CMD='…{user}…' \
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
//   node smoke/browser.mjs
//
// Needs the `playwright` package and a Chromium it can launch. Exit codes:
// 0 passed · 1 failed · 2 crashed. Any console error or page error fails.

import { execSync } from "node:child_process";

const HOST = process.env.TFL5_SMOKE_HOST || "http://localhost:8090";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const verifyCmd = process.env.TFL5_SMOKE_VERIFY_CMD;
const stamp = Date.now();
const USER = `sdk_browser_${stamp}`;
const PASS = `Browser!${stamp}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

let failed = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

try {
  await page.goto(`${HOST}/platform/version`);
  await page.addScriptTag({ url: "/sdk.js" });
  ok("/sdk.js defines window.TFL5", await page.evaluate(() => typeof window.TFL5 === "function"));

  await page.evaluate(
    async ([u, p]) => {
      const t = new window.TFL5();
      await t.auth.register({ username: u, password: p, re_password: p, email: `${u}@example.com` });
    },
    [USER, PASS],
  );
  if (verifyCmd) execSync(verifyCmd.replaceAll("{user}", USER), { stdio: "ignore" });

  const r = await page.evaluate(
    async ([u, p]) => {
      const t = new window.TFL5(); // host = page origin, auth = cookie
      const login = await t.auth.login(u, p);
      const me = await t.auth.me();
      const app = await t.apps.create({ name: `Browser ${Date.now()}` });
      t.useApp(app.tid);
      await t.resources.create({ ma: "note", name: "Note", fields: [{ field: "title" }] });
      const created = await t.resource("note").create({ title: "from the browser" });
      const got = await t.resource("note").get(created.tid);
      await t.site.put({ path: "index.html", text: "<h1>browser</h1>" });
      const live = await t.site.publish("browser smoke");
      const info = await t.platform.info();
      await t.auth.logout();
      let signedOut = false;
      try {
        await t.auth.me();
      } catch (e) {
        signedOut = e instanceof window.tfl5sdk.UnauthorizedError && e.name === "UnauthorizedError";
      }
      return {
        login: login?.user?.username,
        me: me?.user?.username,
        title: got?.data?.title,
        live: typeof live,
        info: Array.isArray(info?.google_allowed_origins),
        cookieHttpOnly: !document.cookie.includes("_token="),
        signedOut,
      };
    },
    [USER, PASS],
  );
  ok("login sets the browser session", r.login === USER && r.me === USER, r);
  ok("doc round-trip through the served bundle", r.title === "from the browser", r);
  ok("site.publish from the browser", r.live === "string", r);
  ok("platform.info (GET) from the browser", r.info === true, r);
  ok("session cookie is not readable by page script", r.cookieHttpOnly === true, r);
  ok("after logout, auth.me() throws UnauthorizedError", r.signedOut === true, r);
  ok("0 console errors", consoleErrors.length === 0, consoleErrors);
} catch (e) {
  console.error("FATAL:", e?.stack || e);
  await browser.close();
  process.exit(2);
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
