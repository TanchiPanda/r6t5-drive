# R6T5 Drive · API 契约（冻结版 · P0/P1）

> 并行开发前冻结。后端严格按此实现，前端严格按此调用。任何字段变更必须先改本文件，再改两端。

## 0. 全局约定

| 项 | 约定 |
|---|---|
| 前缀 | 所有接口在 `/api/*`，返回 `application/json; charset=utf-8` |
| 时间 | ISO 8601 UTC 字符串，如 `2026-11-14T08:00:00.000Z`；前端用 `R6T5.fmtTime/fmtAgo` |
| 字节 | 一律为整数（byte），前端用 `R6T5.fmtBytes` |
| 会话 | Cookie `r6t5_sid`（用户，httpOnly, SameSite=Lax, 7d）+ `r6t5_admin`（管理员，httpOnly, SameSite=Lax, 12h）。**不允许把 token 放 localStorage** |
| 状态码 | 200 成功；201 创建；400 参数错；401 未登录；403 越权；404 不存在；409 冲突/空间满；412 前置未配置；413 单文件超限；429 限流/流量耗尽；500 内部错；501 未实现 |
| 错误体 | `{"error":{"code":"<枚举>","message":"<中文可直接展示>","details":{...}}}` |
| 路径 | 逻辑路径**含 Email 首段**，如 `alice@x.com/inbox/report.pdf`；物理路径 `<STORAGE_ROOT>/alice@x.com/inbox/report.pdf`。目录分隔符固定 `/`，禁止 `..`、空段、绝对路径 |

### 错误码枚举

| code | HTTP | 含义 |
|---|---|---|
| `invalid_input` | 400 | 字段校验失败（details.field 指明） |
| `not_acknowledged` | 400 | 创建存储策略未勾选披露确认（details.publicFields） |
| `unauthorized` | 401 | 无有效会话 |
| `invalid_credentials` | 401 | Supabase 账号密码错 |
| `invalid_admin_password` | 401 | 管理密码错 |
| `forbidden` | 403 | 无权限（含普通用户访问 /admin） |
| `not_found` | 404 | 节点/资源不存在 |
| `conflict` | 409 | 同名节点已存在 |
| `quota_space` | 409 | 用户空间上限（details: limitBytes, usedBytes, needBytes） |
| `quota_file` | 413 | 单文件上限（details: limitBytes, sizeBytes） |
| `quota_traffic` | 429 | 7 天上传流量耗尽（details: limitBytes, usedBytes） |
| `rate_limited` | 429 | 登录尝试过多 |
| `supabase_not_configured` | 412 | 尚未配置 Supabase |
| `supabase_unreachable` | 400 | URL/key 校验失败（details.reason） |
| `storage_not_configured` | 412 | 站点还没有可用的存储策略（初始化未完成时写入类操作会命中） |
| `storage_error` | 500 | 磁盘/适配器错误 |
| `not_implemented` | 501 | P2 能力占位（share 创建等） |
| `internal_error` | 500 | 兜底 |

---

## 1. 身份与鉴权

### POST `/api/auth/login`
```json
// req
{ "email": "alice@x.com", "password": "***" }
// 200
{ "ok": true, "user": publicUser, "setup": { "next": "ready" } }
```
服务端流程：`POST {supabaseUrl}/auth/v1/token?grant_type=password`（Header `apikey: anonKey`）→ 成功则写 `r6t5_sid`（内含 access_token / refresh_token / exp）→ upsert 本地 users 行（按 supabase uid + email）→ 记 audit `login`。
Supabase 未配置 → 412 `supabase_not_configured`。错误密码 → 401 `invalid_credentials`。连续失败 5 次/10 分钟 → 429 `rate_limited`。

### POST `/api/auth/signup`（仅当 `settings.allowSignup=true`）
`{ email, password }` → 透传 `{supabaseUrl}/auth/v1/signup`；返回 `{ ok:true, pendingConfirm:false }`。关闭时 403 `forbidden`。

### POST `/api/auth/logout`
清 cookie → `{ ok:true }`

### GET `/api/me`（需登录）
```json
{
  "user": publicUser,
  "quota": {
    "spaceLimitBytes": 10737418240, "usedBytes": 1234, "spaceRemainingBytes": 10737405906,
    "maxFileSizeBytes": 2147483648,
    "traffic7dLimitBytes": 5368709120, "traffic7dUsedBytes": 1024, "traffic7dRemainingBytes": 5368708096
  },
  "trash": { "count": 2, "bytes": 4096 }
}
```
`publicUser = { id, email, displayName, groupId, groupName, isAdmin, disabled }`

### POST `/api/auth/dev-login`（**仅 `DEV_AUTH=1` 自测用**，生产关闭返回 403）
`{ email }` → 直接写 dev 会话（HMAC 签名的本地 token），返回同 `/api/auth/login`。

### GET `/api/admin/session`
已登录 → `{ "ok": true, "admin": { "passwordSource": "env" | "generated", "loginAt": "..." } }`；否则 401。

### POST `/api/admin/login`
`{ "password": "..." }` → 200 `{ ok:true }` | 401 | 429 `rate_limited`。

### POST `/api/admin/logout`
`{ "ok": true }`

---

## 2. 初始化状态机（登录页只读这一个接口）

### GET `/api/setup/status`（公开）
```json
{
  "ready": false,
  "next": "supabase",
  "hint": "请管理员凭管理密码进入设置页配置 Supabase",
  "link": "/admin/login",
  "linkLabel": "进入管理后台",
  "checks": { "supabase": false, "storage": false, "groups": false, "site": false },
  "site": { "name": "R6T5 Drive", "publicUrl": "", "defaultGroupId": null, "isDefaultSite": true },
  "counts": { "users": 0, "groups": 1, "strategies": 0 }
}
```
`next` 取值与优先级（前者满足才检查后者）：
1. `supabase` — Supabase URL/anon key 未配置或未通过自检
2. `storage` — 无任何启用的存储策略
3. `groups` — 除 admin 外可用用户组 < 2（即 `groups` 表内 `is_default` 之外的组不足 2 个，含默认组）
4. `site` — `siteName` / `publicUrl` / `defaultGroupId` 仍为空或默认值
5. `ready` — 以上全过

`hint` 由服务端给中文文案（前端**只渲染这一条**，不要自己拼文案）：
- supabase：`请管理员凭管理密码进入设置页配置 Supabase`
- storage：`还没有可用的存储策略，请管理员先添加一条`
- groups：`用户组不足 2 个，请管理员创建用户组`
- site：`站点信息仍是默认值，请补全站点名 / 对外地址 / 默认用户组`
- ready：`配置完成，可以使用邮箱登录`

### GET `/api/admin/setup/status`（需管理员）
同上结构 + `"details": { "supabaseUrl": "...", "lastCheckedAt": "..." }`

---

## 3. 管理端 · Supabase

### GET `/api/admin/supabase`
```json
{ "configured": true, "url": "https://xxx.supabase.co", "anonKeyMasked": "eyJhbG…9fQ",
  "serviceKeyMasked": "eyJhbG…7cA", "updatedAt": "2026-…", "lastCheck": { "ok": true, "at": "…", "latencyMs": 143 } }
```
**永不返回明文 key**。

### POST `/api/admin/supabase`
```json
// req
{ "url": "https://xxx.supabase.co", "anonKey": "eyJ…", "serviceKey": "eyJ…" }
// 200
{ "ok": true, "check": { "ok": true, "latencyMs": 120, "checks": { "auth": true, "rest": true, "admin": true } } }
```
校验顺序（**全部通过才落盘，任何一步失败立即返回 400 `supabase_unreachable` 且不写库**）：
1. `url` 必须 `https?://` 且以 `.supabase.co` 域名或自定义域名通过 `GET {url}/auth/v1/health`
2. anon key 调 `GET {url}/auth/v1/settings`（`apikey` header）→ 200
3. service key 调 `GET {url}/auth/v1/admin/users?page=1&per_page=1` → 200
4. 落盘用事务：先写临时行再提交；失败时 `DELETE` 临时行

### POST `/api/admin/supabase/test`
用已存配置复查 → `{ ok, latencyMs, checks, error? }`（失败也 200，用 `ok:false` 表达，避免前端把自检失败当异常）

### DELETE `/api/admin/supabase`
清空配置（同时把已登录用户会话标记失效）→ `{ ok:true }`

---

## 4. 管理端 · 概览

### GET `/api/admin/overview`
```json
{
  "users": { "total": 12, "active7d": 5, "disabled": 1, "pendingUploads": 0 },
  "traffic": { "up7dBytes": 123, "down7dBytes": 456, "upTodayBytes": 12 },
  "storage": {
    "usedBytes": 1024, "capacityBytes": 107374182400, "fileCount": 30, "trashCount": 3,
    "byStrategy": [ { "id": "s1", "name": "本机数据卷", "type": "volume", "usedBytes": 1024, "capacityBytes": 107374182400 } ]
  },
  "groups": [ { "id": "g1", "name": "标准用户", "userCount": 8, "spaceLimitBytes": 10737418240 } ],
  "recent": [ { "id": 12, "at": "2026-…", "email": "a@x.com", "action": "upload", "target": "a@x.com/a.txt", "bytes": 1024 } ],
  "series": { "days": ["11-08","11-09","…"], "uploads": [3,5,…], "trafficBytes": [1024,…] }
}
```
`series` 固定 14 天，供概览图表（前端用纯 CSS/Canvas 画，不引第三方库）。

---

## 5. 管理端 · 用户组

### GET `/api/admin/groups`
```json
{ "items": [ { "id":"g1","name":"标准用户","spaceLimitBytes":10737418240,"maxFileSizeBytes":2147483648,
  "traffic7dLimitBytes":5368709120,"isDefault":true,"userCount":8,"createdAt":"…" } ] }
```

### POST `/api/admin/groups`
`{ name, spaceLimitBytes, maxFileSizeBytes, traffic7dLimitBytes, isDefault? }` → 201 `{ "item": group }`
校验：name 1–32 字且唯一；三个上限均 >0；`isDefault=true` 时原默认组自动取消。

### PATCH `/api/admin/groups/:id`
同字段可选 → `{ "item": group }`。禁止把唯一默认组删掉。

### DELETE `/api/admin/groups/:id`
该组下有用户 → 409 `conflict`（details.userCount）；是默认组 → 409。

---

## 6. 管理端 · 存储策略

### GET `/api/admin/storage/types`（前端弹窗内容全部来自这里，**不要前端硬编码**）
```json
{ "items": [ {
    "type": "volume",
    "label": "本地数据卷",
    "status": "ready",                       // ready | planned
    "capabilities": { "read": true, "write": true },
    "publicFields": [                        // 创建前必须告知：这些会展示给普通用户
      { "key": "name", "label": "策略名" },
      { "key": "type", "label": "存储类型" },
      { "key": "region", "label": "位置/区域" },
      { "key": "capacityBytes", "label": "容量" },
      { "key": "readOnly", "label": "是否只读" }
    ],
    "neverPublic": [ { "key": "config.*", "label": "密钥 / 端点 / 凭证" } ],
    "fields": [
      { "key": "rootPath", "label": "数据目录", "type": "text", "required": false,
        "secret": false, "placeholder": "data/volume", "help": "留空使用默认目录", "default": "data/volume" }
    ],
    "notice": "创建后，普通用户可在界面上看到策略名、类型、位置、容量与是否只读；密钥类字段只保存在服务端，永不下发。",
    "docsHint": "P1 只实现本地卷读写；S3/GitHub 适配器在 P2 落地。"
  } ] }
```
`type` 枚举：`volume`（ready）、`s3`（planned）、`github`（planned）。planned 的类型不允许创建（501）。

### GET `/api/admin/storage`
```json
{ "items": [ { "id":"s1","name":"本机数据卷","type":"volume","region":"本机 data/volume",
  "capacityBytes":107374182400,"usedBytes":1024,"readOnly":false,"enabled":true,
  "configMasked":{ "rootPath":"data/volume" }, "createdAt":"…", "fileCount":30,
  "publicView":{ "name":"本机数据卷","type":"volume","region":"本机 data/volume","capacityBytes":107374182400,"readOnly":false } } ] }
```

### POST `/api/admin/storage`
```json
// req
{ "name":"本机数据卷","type":"volume","region":"本机 data/volume","capacityBytes":107374182400,
  "readOnly":false,"config":{"rootPath":"data/volume"},"acknowledgeDisclosure":true }
```
- `acknowledgeDisclosure !== true` → 400 `not_acknowledged`（details.publicFields 回传，供弹窗展示）
- type 为 planned → 501
- 201 `{ "item": strategy }`

### POST `/api/admin/storage/:id/test`
`{ ok, writable, usedBytes, message }`

### PATCH `/api/admin/storage/:id`、DELETE `/api/admin/storage/:id`
删除策略前要求该策略下 `fileCount === 0`，否则 409。

---

## 7. 管理端 · 用户

### GET `/api/admin/users?q=&page=1&pageSize=20&groupId=`
```json
{ "total": 12, "page": 1, "pageSize": 20,
  "items": [ { "id":"u1","email":"a@x.com","displayName":"","groupId":"g1","groupName":"标准用户",
    "disabled":false,"createdAt":"…","lastLoginAt":"…","usedBytes":1024,"fileCount":3 } ] }
```

### POST `/api/admin/users`（邀请/建号，需 service key）
`{ email, password, groupId }` → 201 `{ "item": user }`；Supabase 未配置 → 412。

### PATCH `/api/admin/users/:id`
`{ groupId?, displayName?, disabled? }` → `{ "item": user }`

### POST `/api/admin/users/sync`
从 Supabase `admin/users` 拉取并 upsert 本地映射 → `{ ok:true, added:3, updated:1, total:14 }`

### DELETE `/api/admin/users/:id`
禁止删除自己/管理员 → 409；否则软禁用户（`disabled=true`）+ 清空会话。

---

## 8. 管理端 · 站点设置 / 审计 / 回收站 / 分享

### GET `/api/admin/settings`
```json
{ "siteName":"R6T5 Drive","publicUrl":"","defaultGroupId":"g1","allowSignup":false,
  "trashRetentionDays":30,"themeDefault":"dark","maxUploadMb":2048,
  "updatedAt":"…","defaults":{"siteName":true,"publicUrl":true,"defaultGroupId":false} }
```
`defaults.*` 为 `true` 表示该字段仍是出厂值，用于 `next:"site"` 判断和高亮。

### PATCH `/api/admin/settings`
`{ siteName?, publicUrl?, defaultGroupId?, allowSignup?, trashRetentionDays?, themeDefault? }` → `{ "item": settings }`

### GET `/api/admin/audit?page=&pageSize=30&action=&email=`
```json
{ "total": 100, "page": 1, "pageSize": 30,
  "items": [ { "id":12,"at":"…","email":"a@x.com","action":"upload","target":"a@x.com/a.txt",
    "bytes":1024,"ip":"203.0.113.x","detail":"" } ] }
```
`action` 枚举：`login` `logout` `upload` `download` `delete` `restore` `rename` `move` `mkdir` `admin_login` `settings_update` `group_create` `storage_create` `user_disable` `share_create`。

### GET `/api/admin/trash`
```json
{ "items":[ {"id":"n1","path":"a@x.com/old.txt","email":"a@x.com","name":"old.txt",
  "sizeBytes":1024,"deletedAt":"…","expiresAt":"…"} ], "retentionDays":30 }
```

### 分享（P1 只有占位）
- `GET /api/shares` → `{ "items": [], "available": false }`
- `POST /api/shares` → 501 `not_implemented`
- `GET /api/share/:token`（公开）→ 501 `not_implemented`，前端展示「P2 规划中」骨架

---

## 9. 用户端 · 文件

### GET `/api/files?path=alice@x.com/inbox`
```json
{ "path":"alice@x.com/inbox","parentPath":"alice@x.com",
  "crumbs":[ {"label":"alice@x.com","path":"alice@x.com"}, {"label":"inbox","path":"alice@x.com/inbox"} ],
  "items":[ {"name":"a.txt","path":"alice@x.com/inbox/a.txt","type":"file","sizeBytes":1024,
             "mime":"text/plain","updatedAt":"…","storageId":"s1"},
            {"name":"sub","path":"alice@x.com/inbox/sub","type":"dir","sizeBytes":0,"itemCount":3,"updatedAt":"…"} ],
  "quota":{ 同 /api/me.quota } }
```
`path` 省略 = 用户根（`<email>`）。首段必须是本人 email，否则 403 `forbidden`。

### POST `/api/files/folder`
`{ "path":"alice@x.com/inbox", "name":"新文件夹" }` → 201 `{ "path":"alice@x.com/inbox/新文件夹" }`
名称校验：不含 `/`，长度 1–200，不可 `.`/`..`。

### POST `/api/files/upload`（`multipart/form-data`）
- query `path` = 目标目录（含 email）
- 字段 `file`（单文件，P1 一次一个；前端可循环）
- 可选字段 `overwrite` = `1`
- 201 `{ "item": fileItem, "quota": {...} }`
- 校验顺序（**必须先查后写，且校验失败不得留下半截文件**）：单文件上限 → 空间剩余 → 7 天流量 → 落盘 → 写元数据 → 记 traffic `upload`
- 错误：413 `quota_file` / 409 `quota_space` / 429 `quota_traffic`

### GET `/api/files/download?path=...&inline=0|1`
流式返回，`Content-Disposition: attachment; filename*=UTF-8''…`；记 traffic `download`（不计入 7 天上传额度，只做统计）。目录路径 → 400。

### POST `/api/files/rename`
`{ "path":"a@x.com/a.txt", "newName":"b.txt" }` → `{ "item": fileItem }`；同名 → 409。

### POST `/api/files/move`
`{ "path":"a@x.com/a.txt", "targetPath":"a@x.com/inbox" }`；目标必须是本人目录；同名 → 409。

### DELETE `/api/files?path=...`
软删（`deleted_at` 置位，物理文件保留）→ `{ "ok":true, "trashed":1 }`；目录递归软删 → `trashed:n`。

### GET `/api/files/search?q=report&path=`
只搜本人可见（未删除）节点 → `{ "items":[ {…同上, "highlight":"…"} ], "total":n }`

### 回收站（用户侧）
- `GET /api/trash` → `{ "items":[ {"path","name","sizeBytes","deletedAt","expiresAt","type"} ], "retentionDays":30 }`
- `POST /api/trash/restore` `{ path }` → `{ "path": "…" }`；同名占用 → 409 `conflict`
- `DELETE /api/trash` `{ path }`（永久删除，落盘删除 + 删元数据）→ `{ "ok":true }`

### GET `/api/account`
```json
{ "user": publicUser, "quota": {...}, "byType": { "image": 1024, "document": 2048, "other": 512 },
  "recentUploads": [ { "path":"…","sizeBytes":1024,"at":"…" } ], "shareCount": 0 }
```

---

## 10. 页面路由（HTML）

| URL | 文件 | 守卫 |
|---|---|---|
| `/` | `public/index.html` | 公开（介绍页，保留原有定位） |
| `/login` | `public/login.html` | 公开；读 `/api/setup/status` 渲染**唯一一条**引导 |
| `/files` | `public/files.html` | 需用户会话；未登录 302 → `/login?next=/files` |
| `/account` | `public/account.html` | 同上 |
| `/share/:token` | `public/share.html` | 公开（P1 显示 P2 占位） |
| `/admin/login` | `public/admin/login.html` | 公开 |
| `/admin`、`/admin/` | 302 → `/admin/home.html` 或 `/admin/login` | — |
| `/admin/home.html` `users.html` `storage.html` `groups.html` `shares.html` `trash.html` `audit.html` `settings.html` | `public/admin/*` | 无管理员会话 → **403 + HTML 提示页**（不是 302） |
| `/assets/*` | 静态 | 公开 |

普通用户（有 `r6t5_sid` 无 `r6t5_admin`）访问任意 `/admin/**` 与 `/api/admin/**` → 403。

---

## 11. 后端目录约定（Subagent A 只写这些）

```
server/index.js          入口：迁移 + 启动 + 打印首次管理密码
server/app.js            express 装配（顺序：cookie → 静态 → 页面 → /api 路由 → 错误处理）
server/config.js         环境变量与 settings 读写
server/db.js             better-sqlite3 连接 + migrate()
server/schema.sql        DDL
server/lib/errors.js     ApiError / 错误码
server/lib/paths.js      路径规范化与安全校验（email 根）
server/lib/session.js    cookie 签名、用户会话、管理员会话、DEV_AUTH
server/lib/format.js     字节/时间
server/middleware/auth.js requireUser / requireAdmin / requireAdminPage
server/routes/{setup,auth,admin-auth,admin-overview,admin-supabase,admin-users,admin-groups,admin-storage,admin-settings,admin-audit,admin-trash,files,trash,account,shares}.js
server/services/{supabase,quota,traffic,audit,nodes}.js
server/services/storage/{registry,volume}.js
```

SQLite 表：`settings` `groups` `users` `nodes` `traffic` `shares` `audit` `storage_strategies`。
数据目录：`DB_PATH`（默认 `data/r6t5.db`）、`STORAGE_ROOT`（默认 `data/volume`）。
