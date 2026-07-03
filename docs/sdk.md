# JS SDK — `@tfl5/sdk`

> 🚧 **ROADMAP — SDK package chưa build.** File này là **design spec** cho JS SDK
> sẽ ship khi tới phase. Nếu bạn là dev đang cần xây ứng dụng trên tfl5 HÔM NAY,
> đọc **[api-reference.md](api-reference.md)** — REST API đầy đủ, đủ để build app
> không cần SDK package. Quay lại file này khi spec cần tinh chỉnh hoặc khi SDK
> bắt đầu được implement.
>
> Trạng thái hiện tại:
> - ❌ `@tfl5/sdk` npm package chưa publish
> - ❌ `/sdk.js` UMD bundle endpoint chưa wire
> - ❌ `@tfl5/cli` codegen chưa build
> - ✅ Tất cả REST endpoint SDK sẽ wrap đã có (xem [api-reference.md](api-reference.md))
>
> **Khi nào ship**: ~3-4 batch sau khi resource UI + DocBus realtime ship
> (priority cao hơn vì gỡ block FE dev productivity ngay).

---

Thư viện client JS cho tenant SPA và Node ứng dụng nói chuyện với tfl5 platform.
Bọc toàn bộ API surface (the platform REST API)
thành object-oriented + Promise-based + TypeScript-aware.

## 1. Phân phối

| Hình thức            | Use case                                      | Output             |
|----------------------|-----------------------------------------------|---------------------|
| `GET /sdk.js`        | Quick-start cho SPA tenant — 1 dòng script    | UMD bundle, đăng ký `window.TFL5` |
| `npm @tfl5/sdk`      | Build pipeline (Vite/Webpack/Next.js)         | ESM + CJS                          |
| `npm @tfl5/cli`      | Codegen TS types từ resource schema           | CLI binary                         |

Server tự host bundle qua `GET /sdk.js` (extension `.js` → trong whitelist
static, nhưng route đặc biệt cao hơn — render từ binary embed thay vì đọc
`assetp/`). Caching aggressive (1 năm, immutable nếu có hash trong URL).

## 2. Browser usage

```html
<!-- Auto-detect host từ URL hiện tại -->
<script src="/sdk.js"></script>
<script>
  const tfl5 = new TFL5();
  await tfl5.login(username, password);
</script>
```

Hoặc ESM:

```html
<script type="module">
  import { TFL5 } from "/sdk.js";
  const tfl5 = new TFL5();
</script>
```

Auto-detect:
- `host` = `window.location.origin`
- `appId` = inferred from server (cookie set by `setConfig` middleware, hoặc
  endpoint `GET /?resource_id=__meta` trả về app config).

## 3. Node usage

```js
import { TFL5 } from "@tfl5/sdk";

const tfl5 = new TFL5({
  host:   "https://acme.com",
  appId:  "a_xxx",                    // explicit, không có window
  token:  process.env.TFL5_TOKEN,     // server-side token
});

await tfl5.user();
```

Node mode dùng `Authorization: Bearer <token>` header thay vì cookie. Token mint
qua endpoint admin của platform.

## 4. API surface — module breakdown

### 4.1 Top-level

```ts
class TFL5 {
  constructor(options?: TFL5Options);

  // Auth
  login(username: string, password: string): Promise<User>;
  logout(): Promise<void>;
  register(input: RegisterInput): Promise<User>;
  resetPassword(username: string, newPassword: string): Promise<void>;

  // Context
  user(): Promise<User | null>;        // null nếu chưa login
  app(): Promise<AppConfig>;           // current app
  license(): Promise<LicenseInfo>;     // combo user + app license

  // Sub-modules
  resource<T extends string>(idOrMa: T): ResourceClient<T>;
  shares: SharesClient;
  files: FilesClient;
  groups: GroupsClient;
  roles: RolesClient;
  apps: AppsClient;
  errors: typeof Errors;               // class references để dùng với instanceof
}
```

### 4.2 ResourceClient — `tfl5.resource("post")`

```ts
interface ResourceClient<T extends string> {
  list(opts?: ListOptions): Promise<ListResult<DocOf<T>>>;
  get(docId: string): Promise<DocOf<T>>;
  add(data: DataOf<T>): Promise<DocOf<T>>;
  edit(docId: string, data: Partial<DataOf<T>>): Promise<DocOf<T>>;
  delete(docId: string): Promise<void>;

  // Sharing convenience
  share(docId: string, opts: ShareOptions): Promise<Share>;

  // Bulk
  reset(filter: FilterRules): Promise<void>;        // app.managers only

  // Hook-triggered ops
  call(fnc: string, params: any): Promise<any>;     // POST /data/sfnc/<resource>/<fnc>
}

type ListOptions = {
  filter?:  FilterRules;
  skip?:    number;
  limit?:   number;       // default 30, max 100
  deleted?: boolean;
};

type ListResult<T> = {
  rows:      T[];
  total:     number;
  skip:      number;
  limit:     number;
  timestamp: number;
};
```

### 4.3 SharesClient — `tfl5.shares`

```ts
interface SharesClient {
  list(filters: ShareListFilters): Promise<Share[]>;
  get(shareId: string): Promise<Share>;
  revoke(shareId: string): Promise<void>;

  // Token claim (anonymous flow)
  claim(token: string): Promise<void>;              // explicit
  claimFromUrl(): Promise<boolean>;                 // tự đọc ?_share= từ URL hiện tại
                                                    //   trả true nếu tìm + claim thành công
}
```

`claimFromUrl` thường được gọi 1 lần ngay sau `new TFL5()` để hấp thụ share URL
anonymous khi user mở public link.

### 4.4 FilesClient — `tfl5.files`

```ts
interface FilesClient {
  upload(path: string, file: File | Blob): Promise<FileEntry>;
  replace(path: string, file: File | Blob): Promise<FileEntry>;
  list(path: string): Promise<FileEntry[]>;
  delete(path: string): Promise<void>;            // soft-delete, recoverable
  rename(path: string, newName: string): Promise<FileEntry>;

  // Trash bin (Batch 24). `delete()` now stamps deleted_at and moves the
  // file under _trash/ on disk; recovery via restore(); permanent removal
  // via purge(). Auto-purge after TFL5_TRASH_TTL_DAYS (default 30).
  trashList(opts?: { stage?: "test" | "release" }): Promise<TrashEntry[]>;
  restore(fileTid: string): Promise<FileEntry>;   // un-delete (Editor+)
  purge(fileTid: string): Promise<void>;          // irreversible (Manager+)

  // Resolve URL
  url(path: string): string;                        // build từ host + path
  signedUrl(path: string, expiresInSec: number): Promise<string>;  // if available

  // Quota check trước upload (optional)
  canUpload(sizeBytes: number): Promise<boolean>;
}

interface TrashEntry {
  tid: string;
  path: string;
  stage: "test" | "release";
  is_dir: boolean;
  size: number | null;
  mime: string | null;
  deleted_at: number;     // epoch ms
  deleted_by: string | null;  // username
  author: string;
}
```

Underlying REST surface (Batch 24):

| Method | Path                    | Auth        | Body                                       |
| ------ | ----------------------- | ----------- | ------------------------------------------ |
| POST   | `/app/file/trash-list`  | Editor+     | `{ app_tid, stage? }`                      |
| POST   | `/app/file/restore`     | Editor+     | `{ app_tid, file_tid }` — fails if active row already at same path |
| POST   | `/app/file/purge`       | Manager     | `{ app_tid, file_tid }` — debits storage   |

### 4.5 GroupsClient — `tfl5.groups` (global)

```ts
interface GroupsClient {
  create(input: { name: string; description?: string }): Promise<Group>;
  list(): Promise<Group[]>;                         // groups user thấy được
  get(groupId: string): Promise<Group>;
  update(groupId: string, input: Partial<Group>): Promise<Group>;
  delete(groupId: string): Promise<void>;
  addMember(groupId: string, userTid: string): Promise<void>;
  removeMember(groupId: string, userTid: string): Promise<void>;
}
```

### 4.6 RolesClient — `tfl5.roles` (per-app)

```ts
interface RolesClient {
  create(input: { name: string; description?: string }): Promise<Role>;
  list(): Promise<Role[]>;
  get(roleId: string): Promise<Role>;
  update(roleId: string, input: Partial<Role>): Promise<Role>;
  delete(roleId: string): Promise<void>;
  addMember(roleId: string, target: Token): Promise<void>;        // target: user_uuid | G_uuid
  removeMember(roleId: string, target: Token): Promise<void>;
}
```

### 4.7 AppsClient — `tfl5.apps`

```ts
interface AppsClient {
  create(input: CreateAppInput): Promise<App>;       // platform.designers required
  list(): Promise<App[]>;                            // apps user có quyền access
  get(appId: string): Promise<App>;
  update(appId: string, input: Partial<App>): Promise<App>;
  delete(appId: string): Promise<void>;
  bindDomain(appId: string, domain: string): Promise<DomainBinding>;
  unbindDomain(domainId: string): Promise<void>;
  listDomains(appId: string): Promise<DomainBinding[]>;
}
```

### 4.8 AuthClient — `tfl5.auth` (PDPD data-subject rights)

Quyền của chủ thể dữ liệu theo **NĐ 13/2023** (Nghị định Bảo vệ dữ liệu cá
nhân). Tất cả đều **self-scoped** — chỉ tác động tài khoản đang đăng nhập,
không có biến thể admin-override.

```ts
interface AuthClient {
  // … login / logout / register / me / các phương thức đăng nhập khác …

  /** Quyền truy cập / mang theo dữ liệu: xuất account + metadata email +
   *  danh sách app đang tham gia của chính mình. */
  exportData(): Promise<DataExport>;

  /** Quyền được xóa: đặt lịch xóa tài khoản của chính mình. Đăng xuất mọi
   *  thiết bị ngay; xóa cứng chạy nền sau grace window (mặc định 24h) — trong
   *  cửa sổ đó gọi cancelErase() để rút lại. Xác nhận bằng `password` (tài
   *  khoản có mật khẩu) hoặc `code` TOTP/backup (tài khoản passwordless có 2FA). */
  eraseAccount(confirm?: { password?: string; code?: string }): Promise<EraseResult>;

  /** Rút lại yêu cầu xóa đang treo (chỉ trong grace window, sau khi login lại). */
  cancelErase(): Promise<EraseResult>;
}
```

```ts
// Xuất dữ liệu của tôi. Trả về đã unwrap: { account, emails,
// app_memberships, regulation, ... } — KHÔNG có wrapper { result, data }.
const dump = await tfl5.auth.exportData();
saveAs(new Blob([JSON.stringify(dump, null, 2)]), "my-tfl5-data.json");

// Đặt lịch xóa tài khoản. Thành công → đăng xuất mọi nơi + trả về lịch xóa.
// Từ chối → NÉM Tfl5Error, bắt theo err.code.
try {
  const r = await tfl5.auth.eraseAccount({ password });
  alert(`Sẽ xóa vào ${new Date(r.erase_after!).toLocaleString()}. `
      + `Đăng nhập lại trước thời điểm đó và gọi cancelErase() để hủy.`);
  // Phiên hiện tại đã bị vô hiệu — coi như đã đăng xuất.
} catch (err) {
  // import { Tfl5Error } from "@tfl5/sdk"
  if (err instanceof Tfl5Error && err.code === "owns_apps") {
    console.warn("Phải chuyển quyền sở hữu / xóa các app này trước:",
                 err.body.app_tids);
  } else throw err;   // password_required / totp_required / lỗi khác
}

// Rút lại trong grace window (sau khi login lại). Ném code:'no_pending_erasure'
// nếu không có yêu cầu nào đang treo.
await tfl5.auth.cancelErase();
```

**Lưu ý:**
- `exportData()` KHÔNG trả địa chỉ email dạng plaintext — lấy qua `POST
  /user/email/list`. Tài liệu/tệp bên trong mỗi app xuất bằng API riêng của
  app đó (`/app/doc/*`, `/app/file/*`).
- `eraseAccount()` **ném** khi bị từ chối — nhánh theo `err.code`:
  `'owns_apps'` (kèm `err.body.app_tids`), `'password_required'`,
  `'totp_required'`. Thành công thì phiên bị vô hiệu ở mọi thiết bị.
- `cancelErase()` ném `code:'no_pending_erasure'` nếu không có gì để hủy.
- Bằng chứng đã-xóa được lưu bền (miễn khỏi purge log 90 ngày) và chỉ chứa
  định danh giả danh — không lộ PII.

## 5. License + quota awareness

```ts
const license = await tfl5.license();
// {
//   user: {
//     tid:               "pro",
//     name:              "Pro",
//     max_apps:          50,
//     max_total_storage: 50_000_000_000,    // 50 GB
//     features:          ["custom_domain", "anonymous_share"]
//   },
//   app: {
//     tid:                "standard",
//     name:               "Standard",
//     max_storage_per_app: 10_000_000_000,
//     features:           ["custom_domain"]
//   },
//   used: {
//     apps:     7,
//     storage:  1_200_000_000
//   },
//   remaining: {
//     apps:     43,
//     storage:  8_800_000_000
//   }
// }
```

SDK methods tự pre-check quota khi upload/create:

```ts
// canUpload trả false nếu vượt quota
const ok = await tfl5.files.canUpload(file.size);
if (!ok) { /* show upgrade UI */ }

// hoặc gọi trực tiếp, throw nếu quota exceeded:
try {
  await tfl5.files.upload(path, file);
} catch (e) {
  if (e instanceof tfl5.errors.QuotaError) {
    /* e.detail = { license, used, requested, available } */
  }
}
```

## 6. TypeScript codegen

```bash
npx @tfl5/cli types --host https://acme.com --app a_xxx --out src/tfl5-types.ts
```

Server đọc `<app>_resources` schema → generate TS interfaces:

```typescript
// Auto-generated. Đừng edit tay.
export interface PostDoc {
  tid: string;
  resource_tid: "r_post";
  author: string;
  data: {
    title:  string;          // required (resource.fields[].validator: "required")
    body?:  string;
    tags?:  string[];
    /** @description Số lượt xem */
    views?: number;
  };
  // ACL fields ẩn khỏi types (designer dùng), client thấy null/undefined
  created_at: number;
  updated_at: number;
}

export interface CommentDoc { ... }

export type ResourceMap = {
  post:    PostDoc;
  comment: CommentDoc;
};

declare module "@tfl5/sdk" {
  interface ResourceMapDef extends ResourceMap {}
}
```

Sử dụng type-safe:

```ts
import "./tfl5-types";

const posts = tfl5.resource("post");
// list type: Promise<ListResult<PostDoc>>
const { rows } = await posts.list();
rows[0].data.title;          // string, autocomplete OK
rows[0].data.unknown;        // ts error

await posts.add({
  title: "Hello",            // required, ts ép
});

await posts.add({
  body: "no title",          // ts error: missing required 'title'
});
```

## 7. Auth modes

### 7.1 Browser (cookie-based)

SDK gửi mọi request với `credentials: 'include'`. `_token` cookie auto-attach
nếu cookie domain khớp (vd `.example.com`).

Login flow:
```ts
const user = await tfl5.login("alice", "hunter2");
// Server set _token cookie, SDK lưu user vào memory
// Subsequent calls tự authenticated
```

### 7.2 Node / server-side (token-based)

```ts
const tfl5 = new TFL5({
  host:  "https://acme.com",
  token: "<jwt-like-token>",      // mint từ admin / service account
  appId: "a_xxx",
});
```

SDK gửi `Authorization: Bearer <token>` mọi request.

Token được mint qua endpoint mới (TBD): `POST /admin/token` (chỉ
`platform.managers`).

## 8. Anonymous mode + share token

User chưa login:

```ts
const tfl5 = new TFL5();           // không login

// Doc với readers=[] → đọc OK
const publicDoc = await tfl5.resource("post").get("d_xxx");

// Doc cần auth → throw AuthError
try {
  await tfl5.resource("post").get("d_private");
} catch (e) {
  if (e instanceof tfl5.errors.AuthError) { /* show login */ }
}

// Hấp thụ share token từ URL ?_share=xxx
await tfl5.shares.claimFromUrl();
// Sau đó các call tiếp theo có thể access doc qua share
```

`claimFromUrl()` set internal flag để mọi request kế tiếp tự add header
`X-Share-Token`. Khi user logout / refresh, share lifetime kết thúc theo
`expires_at` server-side.

## 9. Error classes

```ts
class TFL5Error extends Error {
  constructor(message: string, public code: string, public detail?: any) {}
}

class AuthError extends TFL5Error { ... }              // chưa login / token expired
class PermissionError extends TFL5Error { ... }        // access denied
class QuotaError extends TFL5Error { detail: QuotaDetail }
class ValidationError extends TFL5Error { errors: FieldError[] }
class NotFoundError extends TFL5Error { ... }
class NetworkError extends TFL5Error { ... }
class LicenseError extends TFL5Error { ... }           // feature not in tier
```

Pattern:

```ts
try {
  await tfl5.resource("post").add({ body: "no title" });
} catch (e) {
  if (e instanceof tfl5.errors.ValidationError) {
    e.errors.forEach(err => { /* { field, message } */ });
  } else if (e instanceof tfl5.errors.QuotaError) {
    /* show upgrade UI */
  } else if (e instanceof tfl5.errors.PermissionError) {
    /* show 403 */
  } else {
    throw e;
  }
}
```

## 10. Cache strategy — open

v1 SDK **không có built-in cache**. Mỗi call = 1 HTTP request.

Dev tự quản:

```ts
// Tự cài cache layer
import { TFL5 } from "@tfl5/sdk";
import { LRUCache } from "lru-cache";

class CachedTFL5 extends TFL5 {
  private cache = new LRUCache({ max: 500, ttl: 30_000 });
  // ... override resource() để wrap
}
```

Hoặc dùng `react-query` / `swr` ở UI layer.

v1.5 có thể thêm built-in (`tfl5.cache.enabled = true` + invalidation rules).

## 11. Real-time — open

v1 SDK **không có real-time**. Muốn cập nhật → polling tay:

```ts
const sub = setInterval(async () => {
  const { rows } = await posts.list({ filter: { ... } });
  /* update UI */
}, 10_000);

clearInterval(sub);   // cleanup
```

v1.5 có thể thêm `tfl5.resource("post").subscribe(filter, cb)` với SSE backend.

## 12. Bundle budget

| Bundle           | Mục đích                        | Target gzip |
|------------------|---------------------------------|-------------|
| `core`           | Auth + Resource CRUD + Files    | < 15 KB     |
| `+sharing`       | + Shares + claim token          | < 22 KB     |
| `+types`         | + TS runtime helpers            | < 25 KB     |
| `+cache`         | (v1.5) + LRU cache + invalidate | < 35 KB     |
| `+realtime`      | (v1.5) + SSE client             | < 45 KB     |

Tree-shakable — chỉ import phần dùng.

## 13. Versioning

- Semver. Major bump = breaking change.
- Server và SDK độc lập versioning, nhưng SDK x.y.z compatible với server x.y.{any}.
- SDK đầu mỗi request gửi header `X-TFL5-SDK-Version: <ver>` cho server log.

## 14. Mở rộng tương lai

- **v1.5:** built-in cache, SSE real-time, optimistic updates.
- **v2:** offline mode (IndexedDB cache + sync queue).
- **v2.5:** TypeScript decorators cho resource classes (`@Resource("post") class Post {}`).
- **v3:** GraphQL adapter trên cùng API surface.
