# Files and sites

An app stores two kinds of files, with different life cycles:

| STT | Kind | API | Who reads it |
|---|---|---|---|
| 1 | the app's front-end (HTML, JS, CSS, images) | `tfl5.site` (recommended), `tfl5.bundle`, or `tfl5.files` + `tfl5.stages` | every visitor of the app's domain |
| 2 | files your users upload | `tfl5.files`, `tfl5.f3` (encrypted, bound to a doc) | whoever the file's ACL allows |

## Publishing the front-end with the site engine

The site engine keeps every published version. You edit a draft, publish it
atomically, and can roll back to any earlier version:

```ts
await tfl5.site.put({ path: "index.html", text: "<h1>Hello</h1>" });
await tfl5.site.put({ path: "logo.png", base64: pngBase64 });
const live = await tfl5.site.publish("first version");   // id of the new live snapshot

const versions = await tfl5.site.history();               // newest first, with is_live / is_draft
await tfl5.site.rollback(versions[1].id);                 // any published snapshot
```

- Identical bytes are stored once (`put` reports `deduped: true`).
- `publish()` refuses an empty draft, so it cannot wipe the live site.
- `site.previewUrl("index.html")` is a URL that renders the draft (for an
  `<iframe>`; the browser needs the Manager's session cookie).
- An app that already serves a bundle or release files can move to the site
  engine with `site.importCurrent()`, once.

Once an app has published through the site engine, that is what visitors
get: bundles and release-stage files are no longer served for it.

All `site` methods need Manager on the app.

### Bundles (zip upload)

If you build the front-end elsewhere, upload the build as a zip with a
version label and switch versions atomically:

```ts
await tfl5.bundle.upload({ version: "1.4.0", file: zipBlob, notes: "checkout fix" });
await tfl5.bundle.activate("1.4.0");
await tfl5.bundle.rollback();          // back to the previous version
await tfl5.bundle.delete("1.2.0");     // not the live or the previous one
```

## User files

```ts
const { files, warnings } = await tfl5.files.upload(
  { path: "avatars/u-42.png", file: pngBlob, filename: "u-42.png" },
  { stage: "release" },
);
// warnings (rare): the write is stored but not served — see "Stages" below
const all = await tfl5.files.list({ prefix: "avatars/" });
const { signed_url } = await tfl5.files.signUrl("avatars/u-42.png");   // valid 5 min by default
```

- `path` is the file's full path inside the app, not a folder.
- Max 50 MiB per file. Allowed types: html/css/js/json, images, fonts, text,
  sqlite/db/bin, wasm, zip/tar/gz.
- `save({ path, contentBase64 })` / `get(path)` move content as base64 JSON,
  for runtimes without `FormData`; `get` refuses files over 10 MiB
  (`file_too_large`), use `signUrl` for those.

### Stages

Each file lives in the `test` (draft) or `release` (live) stage. The server's
defaults differ on purpose so a forgotten field never overwrites live files:
writes (`upload`, `save`) default to `test`, reads (`list`, `get`, `signUrl`)
to `release`. This client sends `release` on `rename`, `del`, `createFolder`
and `aclSet` unless you pass `stage`. Pass `{ stage: "release" }` when you
mean to write live files directly.

If the app's front-end is published through the site engine, release-stage
writes are stored but not served; such writes come back with a `warnings`
entry `file_write_shadowed_by_snapshot` (servers in strict mode refuse them
with that code). Publish front-end files with `tfl5.site` instead.

`tfl5.stages.promote()` copies the test stage over release in the background
and returns a `job_id`; follow it with `stages.releaseStatus(job_id)`.
`stages.rollbackRelease()` swaps back to the previous release.

### Trash

```ts
await tfl5.files.del("avatars/u-42.png");       // to the trash
const trash = await tfl5.files.trashList();
await tfl5.files.restore(trash[0].tid);         // or { newPath } if the path was reused
await tfl5.files.purge(trash[0].tid);           // Manager; permanent, no confirmation step
```

### File ACL

`files.aclSet({ path, readers: ["u-…"] })` (Manager) replaces the file's ACL
arrays; arrays you leave out are stored empty.

## Encrypted attachments on a doc (F3)

```ts
const meta = await tfl5.f3.upload({ app_tid: appTid, doc_tid: docTid, level: 2, name: "scan.pdf", file });
const blob = await tfl5.f3.download(meta.tid);
```

Levels: `1` encrypted; `2` encrypted and every download is logged
(`f3.accessLog`); `3` encrypted per recipient — only users granted with
`f3.grant(f3Tid, userTid)` can read it.

## Custom domains

```ts
const preview = await tfl5.domain.preview("shop.example.com");   // the DNS records to create
const d = await tfl5.domain.add("shop.example.com");            // d.warnings lists DNS problems
await tfl5.domain.verify(d.tid);
```

Adding and verifying a domain needs Manager on the app; unbinding one needs
the Owner. The owner of a parent domain can also let other apps bind its
subdomains (the delegation methods in the [API reference](reference.md#tfl5domain--domainclient)).
