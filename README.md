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
| [`docs/sdk.md`](docs/sdk.md) | SDK design spec + full TypeScript surface. |

## Quick start

```bash
npm install @tfl5/sdk
```

```ts
import { TFL5 } from "@tfl5/sdk";

const tfl5 = new TFL5({ host: "https://your-app.example.com" });
await tfl5.auth.login("username", "password");
tfl5.useApp("a-xxxx");

const task = tfl5.resource<{ title: string; status: string }>("task");
await task.create({ title: "Hello", status: "todo" });
const open = await task.list({ where: { status: "todo" } });
```

In the browser, every tafalo5 server also serves the bundle directly — drop
in `<script src="/sdk.js"></script>` and use `window.TFL5` with no build step.
See [sdk/README.md](sdk/README.md#no-build--script-usage--served-by-the-platform).

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
