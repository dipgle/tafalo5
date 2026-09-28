# Authentication

Every sign-in method ends the same way: the server sets the `_token` session
cookie. In a browser the cookie is handled for you. In Node the SDK keeps it
in an in-memory cookie jar, so the same code works on both sides.

```ts
const tfl5 = new TFL5({ host: "https://your-server.example.com" });
await tfl5.auth.login("alice", "…");
const { user } = await tfl5.auth.me();     // throws UnauthorizedError when signed out
await tfl5.auth.logout();
```

## Modes

| STT | Mode | When | How |
|---|---|---|---|
| 1 | cookie (default) | browsers; Node scripts that sign in as a user | `new TFL5({ host })` then any sign-in method |
| 2 | bearer | server-to-server integrations | `new TFL5({ host, token: "st_…" })` |

Service tokens (`st_…`) are issued by the platform operator; there is no
tenant endpoint to mint one. Signed data sources (see [data.md](data.md))
are the self-service way for an external system to push data in.

## Registration and email verification

```ts
await tfl5.auth.register({ username, password, re_password: password, email });
```

The server emails a verification link. Until it is followed the account
cannot create apps or change data in apps it owns (code
`email_not_verified`); `tfl5.account.sendVerification()` sends the link
again. If `(await tfl5.platform.info()).turnstile_enabled` is true, the
server also requires a Cloudflare Turnstile token: render the widget with
`turnstile_site_key` and pass its response as `turnstile_token`.

## Other sign-in methods

What a server offers is in `tfl5.platform.info()` (Google / Microsoft client
ids, Telegram bot name, SSO host, Turnstile). Pass an app tid to get that
app's own OAuth client ids.

### Google

In a browser, let the SDK render the button:

```ts
import { mountGoogleButton } from "@tfl5/sdk/ui";   // or /sdk-ui.js on the server

await mountGoogleButton(tfl5, {
  target: "#google",
  onSignIn: ({ user }) => location.assign("/app"),
  onRequiresPassword: async (usernameHint) => prompt(`Password for ${usernameHint}`),
});
```

Or pass the credential yourself: `await tfl5.auth.google(response.credential)`.
If an unverified account already owns the email, the call throws a
`BadRequestError` with `body.requires_password`; call again with
`{ password }` to prove ownership and link the accounts.
`tfl5.auth.microsoft(idToken)` works the same way with an MSAL ID token.

### Magic link

```ts
await tfl5.auth.magicLink("alice@example.com", { redirectTo: "/app" });
```

Always answers success, whether or not the address has an account. The link
opens a page on the server that sets the session and redirects.

### Phone (one-time code)

```ts
await tfl5.auth.phoneStart("+84901234567");
await tfl5.auth.phoneVerify("+84901234567", codeTheUserTyped);
```

Needs an SMS/Zalo channel configured on the server.

### QR code (sign in on a desktop with a signed-in phone)

```ts
// desktop
const { session_id, approve_url } = await tfl5.auth.qrStart();
showQr(approve_url);
let r;
do {
  await sleep(2000);
  r = await tfl5.auth.qrPoll(session_id);          // "pending" | "consumed" | "expired" | "rejected"
} while (r.status === "pending");
if (r.status === "consumed") { /* signed in as r.user */ }

// phone, already signed in, after scanning
await tfl5.auth.qrApprove(sessionId);              // or qrReject(sessionId)
```

Sessions expire after 5 minutes.

### Telegram

Telegram is a second sign-in method for an existing account. Load the
Telegram Login Widget for `platform.info().telegram_bot_username`; pass the
object it gives your callback straight through:

```ts
await tfl5.auth.telegramLink(widgetPayload);   // signed in: attach Telegram
await tfl5.auth.telegramLogin(widgetPayload);  // later: sign in with it
await tfl5.auth.telegramStatus();              // { configured, bot_username, linked }
```

### VNeID

For apps with the VNeID operator enabled:

```ts
const { authorize_url } = await tfl5.auth.vneidStart({ appTid, redirectTo: "/app" });
location.assign(authorize_url);    // VNeID sends the browser back to the server, which signs it in
```

## Two-factor authentication

```ts
const { provisioning_uri, secret_base32, backup_codes } = await tfl5.account.twoFaEnroll();
// show provisioning_uri as a QR code; backup_codes are shown only this once
await tfl5.account.twoFaConfirm(codeFromAuthenticator);   // { confirmed: true }
await tfl5.account.twoFaVerify(code);                     // when a session must pass 2FA
await tfl5.account.twoFaDisable(code);
```

## Account management

`tfl5.account` covers the signed-in user's profile, password
(`changePassword`, `setPassword` for passwordless accounts), username,
linked Google/Microsoft identities and secondary emails. Refusals are thrown
as `Tfl5Error` with a `code` (for example `totp_required`, `has_password`,
`email_mismatch`).

`tfl5.identity` lets a user share their avatar and display name with chosen
people, groups, roles or app members, and revoke that at any time:

```ts
await tfl5.identity.set("display_name", "An Nguyen");
const grantId = await tfl5.identity.share({ facet: "display_name", audienceType: "app_members", audienceRef: appTid });
const people = await tfl5.identity.resolve({ userTids, appTid });   // only what each viewer may see
await tfl5.identity.revoke({ grantId });
```
