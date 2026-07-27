# tafalo5 — SDK & developer docs

Official JavaScript/TypeScript **client SDK** and **developer documentation**
for the [tafalo5](https://tafalo.com) app platform. This repository contains
only the client-side surface — the backend is not part of it.

You point the SDK at a running tafalo5 server (the hosted platform, or your
own instance) and build apps against a fixed REST contract: `apps →
(groups, roles, resources, docs)`, per-row ACL, field-level encryption,
declarative hooks, and sandboxed operators.

## Contents

| Path | What |
|---|---|
| [`sdk/`](sdk/) | `@tfl5/sdk` — the typed client (`TFL5`, resources, auth, files, shares, operators). See [sdk/README.md](sdk/README.md). |
| [`docs/README.md`](docs/README.md) | Documentation index — start here. |
| [`docs/app-builder-guide.md`](docs/app-builder-guide.md) | Build your first app end-to-end. |
| [`docs/api-reference.md`](docs/api-reference.md) | Full REST endpoint reference. |
| [`docs/acl-model.md`](docs/acl-model.md) | Authorization: ACL arrays, roles, groups, sharing. |
| [`docs/recipes.md`](docs/recipes.md) | Task-oriented how-tos. |
| [`docs/sdk.md`](docs/sdk.md) | Full SDK reference — every client module, the auth/error model, and what's landing next. |

## Quick start

Every tafalo5 server serves the SDK directly — no build step, no npm install:

```html
<script src="/sdk.js"></script>
<script>
(async () => {
  const tfl5 = new TFL5();                 // host defaults to window.location.origin
  await tfl5.auth.login("username", "password");
  tfl5.useApp("a-xxxx");

  const task = tfl5.resource("task");
  await task.create({ title: "Hello", status: "todo" });
  const open = await task.list({ where: { status: "todo" } });
})();
</script>
```

See [sdk/README.md](sdk/README.md#no-build--script-usage--served-by-the-platform)
for the ESM (`/sdk.mjs`) form and more detail.

`@tfl5/sdk` isn't published to npm yet (see [sdk/README.md](sdk/README.md) for
current status) — for a Node/CLI build pipeline, build it from source today:

```bash
cd sdk && npm install && npm run build
```

```ts
import { TFL5 } from "@tfl5/sdk"; // resolved to sdk/dist once built, or a local path

const tfl5 = new TFL5({ host: "https://your-app.example.com" });
await tfl5.auth.login("username", "password");
tfl5.useApp("a-xxxx");

const task = tfl5.resource<{ title: string; status: string }>("task");
await task.create({ title: "Hello", status: "todo" });
const open = await task.list({ where: { status: "todo" } });
```

## Prerequisites

The SDK is a client — it needs a tafalo5 server to talk to:

- **Hosted:** point `host` at your tafalo5 instance on the platform.
- **Self-hosted:** run your own tafalo5 server, then point `host` at it.

## Build the SDK from source

```bash
cd sdk
npm install
npm run build          # dist/ (ESM + .d.ts)
npm run build:browser  # dist/browser/sdk.{js,mjs}
```

## License

See [LICENSE](LICENSE).
