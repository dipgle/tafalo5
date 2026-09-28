# Getting started

This walks from an empty account to an app with a resource and some docs.
Every call below is a real request to your Tafalo server.

## 1. Create a client

```ts
import { TFL5 } from "@tfl5/sdk";

// In a browser on your app's own domain you can omit `host`.
const tfl5 = new TFL5({ host: "https://your-server.example.com" });
```

`host` is the origin the SDK talks to. The server works out which app a
request belongs to from the `Host` header and from the `app_tid` in the body,
so an app served on its own domain can call the API on that same domain.

## 2. Register and sign in

```ts
await tfl5.auth.register({
  username: "alice",
  password: "correct horse battery staple",
  re_password: "correct horse battery staple",
  email: "alice@example.com",
});
await tfl5.auth.login("alice", "correct horse battery staple");
const me = await tfl5.auth.me();      // { user: { tid, username, … }, platform: { … } }
```

A new account must confirm its email (the link sent at registration) before
it can create an app or change data in an app it owns. Until then those calls
fail with code `email_not_verified`. A user whom an app's owner has granted
access can work in that app right away.

## 3. Create an app and scope the client to it

```ts
const app = await tfl5.apps.create({ name: "Team tasks" });
tfl5.useApp(app.tid);                 // app_tid is now sent with every call
```

The number of apps you can own depends on your plan
(`await tfl5.billing.account()` shows `apps_used` and `remaining`).

## 4. Define a resource

A resource is a typed collection. `ma` is its machine alias; you use it to
address the resource afterwards.

```ts
import { FieldLevel } from "@tfl5/sdk";

await tfl5.resources.create({
  ma: "task",
  name: "Task",
  fields: [
    { field: "title", validator: "required" },
    { field: "status" },
    { field: "private_note", level: FieldLevel.Sensitive }, // encrypted at rest
  ],
});
```

Fields at level 1 or 2 are encrypted on the server. You read and write them as
plain values, but you cannot filter on them.

## 5. Work with docs

```ts
const tasks = tfl5.resource<{ title: string; status?: string; private_note?: string }>("task");

const t = await tasks.create({ title: "Write docs", status: "todo" });
const one = await tasks.get(t.tid);               // one.data.title === "Write docs"

await tasks.patch(t.tid, { status: "done" });     // merge into the existing data
await tasks.update(t.tid, { title: "Write docs", status: "done" }); // full replace

const todo = await tasks.list({ where: { status: "todo" }, limit: 50 });
await tasks.del(t.tid);                            // soft delete
```

`update()` replaces the whole `data` object: any field you leave out is
removed. Use `patch()` to change a few fields.

## 6. Invite someone

```ts
const [role] = await tfl5.roles.list();

// Someone who already has an account: find them, then give them a role.
const [bob] = await tfl5.apps.searchMembers("bob");
await tfl5.apps.setMemberRoles(bob.user_tid, [role.tid]);

// Someone new: invite by email. They get a sign-in link.
await tfl5.apps.invite({ email: "carol@example.com", roleTids: [role.tid] });
```

`invite()` takes an email address only. If that address already has an
account, the server adds that user to `roleTids` right away and answers
`status: "user_already_exists"` with the `user_tid` — no second call needed.
(`setMemberRoles()` *replaces* a member's roles; use it to change them later.)

What a member can do is decided by roles and ACL arrays — see
[data.md](data.md#access-control).

## Next

- [Authentication](authentication.md) — Google, QR, phone, service tokens.
- [Data](data.md) — queries, paging, hooks, import, sharing.
- [Files and sites](files-and-sites.md) — storage and publishing your app's front-end.
- [API reference](reference.md) — every method.
