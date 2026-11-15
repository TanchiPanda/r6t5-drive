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
| `invalid_credentials` | 401 | 账号密码错（supabase / 本地统一文案） |
| `account_banned` | 403 | 账号已被封禁（P6） |
| `not_supported_in_source` | 409 | 当前账号来源不支持该操作（P6） |
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
> **P6 起语义改为真正删号**，详见 §P6-4。`?deleteFiles=0|1` 控制是否连带删除文件节点与物理对象；Supabase 账号仅删本地记录（`supabaseUserKept:true`）。旧版「仅禁用用户」的行为已废弃。

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

---

# P2 追加：多存储后端（本段优先于上文冲突项）

## P2-0 新增错误码

| code | HTTP | 含义 |
|---|---|---|
| `strategy_readonly` | 403 | 目标策略只读（GitHub），写操作被拒；`details.strategyId/strategyType` |
| `upstream_error` | 502 | S3 / GitHub 上游失败；`details.provider/op/status` |
| `storage_unsupported` | 400 | 该策略不支持此操作（如只读上的 rename/move） |

## P2-1 存储类型注册表 `GET /api/admin/storage/types`

三种类型均为 `status:"ready"`。`fields[]` 每项：`{key,label,type:'text'|'password'|'select'|'number',required,secret,placeholder?,help?,default?,options?[]}`。

**volume**（不变）：`rootPath`

**s3**
```json
{ "type":"s3","label":"S3 兼容对象存储","status":"ready",
  "capabilities":{"read":true,"write":true,"list":true},
  "publicFields":[策略名/存储类型/位置-区域/容量/是否只读],
  "neverPublic":[{"key":"config.endpoint","label":"服务端点"},{"key":"config.accessKeyId","label":"Access Key ID"},{"key":"config.secretAccessKey","label":"Secret Access Key"}],
  "fields":[
    {"key":"endpoint","label":"Endpoint","type":"text","required":true,"placeholder":"https://s3.us-east-1.amazonaws.com","help":"AWS S3 / R2 / MinIO / 七牛 / OSS / COS / OBS / KS3 等 S3 兼容服务"},
    {"key":"region","label":"Region","type":"text","required":true,"default":"us-east-1"},
    {"key":"bucket","label":"Bucket","type":"text","required":true},
    {"key":"accessKeyId","label":"Access Key ID","type":"text","required":true,"secret":true},
    {"key":"secretAccessKey","label":"Secret Access Key","type":"password","required":true,"secret":true},
    {"key":"prefix","label":"对象前缀","type":"text","required":false,"placeholder":"r6t5-drive"},
    {"key":"pathStyle","label":"访问形态","type":"select","required":false,"default":"auto",
     "options":[{"value":"auto","label":"自动"},{"value":"on","label":"path-style"},{"value":"off","label":"virtual-host"}]}
  ],
  "notice":"创建后，普通用户只会看到策略名、类型、区域、容量与是否只读；Endpoint、Access Key、Secret Key 仅存服务端，永不下发。",
  "docsHint":"使用 AWS SigV4 签名；上传为流式，不整文件读入内存。"}
```

**github**
```json
{ "type":"github","label":"GitHub 仓库（只读）","status":"ready",
  "capabilities":{"read":true,"write":false,"list":true},
  "neverPublic":[{"key":"config.token","label":"访问令牌"}],
  "fields":[
    {"key":"repo","label":"仓库","type":"text","required":true,"placeholder":"owner/repo"},
    {"key":"branch","label":"分支","type":"text","required":false,"default":"main"},
    {"key":"rootPath","label":"仓库内根目录","type":"text","required":false,"placeholder":"drive"},
    {"key":"token","label":"访问令牌","type":"password","required":false,"secret":true,
     "help":"公开仓库可留空；私有仓库需要 repo 读权限的 fine-grained token"}
  ],
  "notice":"创建后，普通用户只会看到策略名、类型、仓库名与只读标记；访问令牌仅存服务端。",
  "docsHint":"列目录走 Contents API，下载走 raw；本策略所有写操作返回 403 strategy_readonly。"}
```

## P2-2 `GET /api/admin/storage` 列表项扩展

```json
{ "id":"s1","name":"…","type":"s3","region":"us-east-1 · my-bucket",
  "capacityBytes":…, "usedBytes":…, "readOnly":false, "enabled":true, "fileCount":…,
  "capabilities":{"read":true,"write":true,"list":true},
  "configMasked":{ "endpoint":"https://…","bucket":"my-bucket","prefix":"r6t5-drive","accessKeyId":"****9fQZ" },
  "health":{ "ok":true|false|null, "checkedAt":"…", "message":"…" },
  "publicView":{ "name","type","region","capacityBytes","readOnly" } }
```
`configMasked` 规则：密钥/token 一律 `****` + **末四位**；端点、bucket、prefix、repo、branch、rootPath 明文可回（它们不是密钥）。

## P2-3 创建 / 校验 / 自检

- `POST /api/admin/storage`：`{name,type,region?,capacityBytes,readOnly?,config,acknowledgeDisclosure:true}`，三种类型都可创建；缺必填字段 → `400 invalid_input`（`details.field`）。s3 默认 `readOnly:false`；github 强制 `readOnly:true`。
- `POST /api/admin/storage/validate`：`{type,config}` → **未保存先测**。S3 走 HeadBucket + ListObjectsV2(prefix, max-keys=1)，GitHub 走 `GET /repos/{owner}/{repo}` + `GET /branches/{branch}`。返回 `{ok,message,details}`，失败也 200。
- `POST /api/admin/storage/:id/test`：同上，用已存配置；结果写入 `health`（settings 表 `health:<id>`）并返回 `{ok,writable,message,details}`。

## P2-4 目录绑定 `/api/admin/bindings`

```json
// GET → { items:[{ id, strategyId, strategyName, strategyType, strategyReadOnly,
//                  scope:'site'|'user', email:null|'a@x.com', subPath:'', createdAt }] }
// POST { strategyId, scope, email?, subPath:'' } → 201 { item }
// PATCH /:id { strategyId?, scope?, email?, subPath? } → { item }
// DELETE /:id → { ok:true }
// GET /api/admin/bindings/resolve?path=alice@x.com/media
//   → { strategy:{id,name,type,readOnly,region}, matchedBy:'binding'|'group'|'local', bindingId?, depth?, subPath? }
```
`subPath` 相对**用户根**，`''` 表示用户根本身；`scope:'site'` 对所有用户生效，`scope:'user'` 只对 `email` 生效。

## P2-5 用户端文件接口变化

`GET /api/files` 响应新增：
```json
{ "strategy": { "id":"s1","name":"…","type":"s3","readOnly":false,"region":"…",
                "matchedBy":"binding|group|local","bindingId":"b1","bindingPath":"media" },
  "items": [ … , { "name":"a.txt","path":"…","type":"file","sizeBytes":…,"remote":true,"readOnly":true } ] }
```
- `remote:true` 表示该条目来自远端列举（S3 前缀 / GitHub Contents），不在本地 SQLite 元数据里。
- 目录落在只读策略时，`strategy.readOnly=true`，前端应把上传/新建/重命名/移动/删除入口禁用并给出说明。

写操作（`POST /api/files/upload`、`/folder`、`/rename`、`/move`、`DELETE /api/files`、`DELETE /api/trash`）在目标策略只读时返回 `403 strategy_readonly`。

## P2-6 用户组默认策略

`GET/POST/PATCH /api/admin/groups` 的 item 增加 `defaultStrategyId`（可为 `null`）。站点设置 `GET/PATCH /api/admin/settings` 增加 `defaultStorageId`（可为 `null`，解析顺序见 `docs/storage-drivers.md` §5）。

---

# P3 追加：分享与预览（本段优先于上文冲突项）

P3 实现时 P1 的 `shares` 占位表结构不同，`db.migrate()` 会在检测到旧结构（缺 `email` 列）时 `DROP TABLE shares` 重建——P1 阶段分享接口一律 501，未写入过数据，因此重建不损失业务数据。

## P3-0 新增错误码

| HTTP | code | 场景 |
|---|---|---|
| 404 | `share_not_found` | token 不存在 / 分享已删除 / 查看他人分享 |
| 410 | `share_expired` | 分享已过有效期 |
| 410 | `share_revoked` | 分享已被创建者或管理员撤销 |
| 410 | `share_exceeded` | 下载次数已达上限 |
| 401 | `share_code_required` | 需要提取码但当前请求未解锁（仅 list/download/preview） |
| 403 | `share_code_invalid` | 提取码错误（同一 IP+token 连错 5 次后锁定 15 分钟） |
| 415 | `preview_unsupported` | 类型不支持在线预览（含 SVG，故意不支持） |
| 413 | `preview_too_large` | 超出预览大小上限 |

## P3-1 用户端分享（`/api/shares`，需登录）

### POST `/api/shares`
body：`{ path, expiresIn, code, maxDownloads, allowPreview }`

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 逻辑路径，必须是本人节点，不能是用户根 |
| `expiresIn` | string | `permanent`（默认）/`1d`/`7d`/`30d`/ISO8601 时间 |
| `code` | string? | 提取码 4–16 位字母数字；空表示无码 |
| `maxDownloads` | number? | 1–100000；空表示不限 |
| `allowPreview` | bool | 默认 true |

201 `{ item }`，item 字段：`id, token, url('/s/<token>'), name, path, isDir, expiresAt, maxDownloads, downloadCount, allowPreview, hasCode, createdAt, status, revokedAt`

- `status`: `active|expired|revoked|exhausted`（服务端计算）
- 提取码只存 PBKDF2(sha512, 10 万次) 派生值与 salt，明文不落库、不回显、不进日志
- 同路径未撤销分享上限 20 条，超出 `409 conflict`

### GET `/api/shares` → `{ items: [...] }`（本人，createdAt 倒序）
### GET `/api/shares/:id` → `{ item }`（不存在或他人 → `404 share_not_found`）
### DELETE `/api/shares/:id` → `{ ok: true }`（写 `revokedAt`，幂等）

## P3-2 公开访问（`/api/share`，免登录）

### GET `/api/share/:token`
→ `{ share: { name, isDir, allowPreview, hasCode, expiresAt, maxDownloads, downloadCount, remaining, status }, locked }`
- `remaining` 为 `null` 表示不限；`locked=true` 表示有提取码且当前未解锁（**此处不报错**）

### POST `/api/share/:token/unlock`
body `{ code }` → `{ ok: true, unlocked: true }`，并下发 httpOnly Cookie `r6t5_share_<token前8位>`（`SameSite=Lax`、`Path=/`，值为签名 payload `{token}`）
- 错码 `403 share_code_invalid`

### GET `/api/share/:token/list?path=`
→ `{ path, crumbs, items: [{ name, path, type, sizeBytes, mime, updatedAt }] }`
- 仅目录分享可列；单文件分享 → `400 invalid_input`
- 路径必须落在分享目录内，越界 `403 forbidden`
- 条目 = 本地节点 ∪ 远端策略列举（失败降级为空，不影响列表）

### GET `/api/share/:token/download?path=`
- 目录分享必须带 `path`；单文件分享忽略该参数
- 未解锁 `401 share_code_required`；过期/撤销/超次 → 410 三码
- 成功后 `downloadCount += 1`、写 `share_hits`、给**分享创建者**记下载流量
- 响应 `Content-Disposition: attachment; filename*=UTF-8''...`

### GET `/api/share/:token/preview?path=`
- `allowPreview=false` → `403 forbidden`
- 其余行为与「P3-3 预览」一致（同一实现）

## P3-3 登录用户预览（`/api/files/preview`，需登录）

### GET `/api/files/preview?path=<逻辑路径>&exif=0|1`
按类型返回：

| 类型 | 扩展名 | 响应 |
|---|---|---|
| 图片 | png/jpg/jpeg/gif/webp/bmp/avif | 二进制 inline，`Content-Type` 对应；`exif=1` 时附 `X-Image-Orientation: 1..8`（前端 CSS 旋转，服务端不重编码） |
| 视频 | mp4/webm/m4v/mov | 支持 `Range`：`206 + Content-Range + Accept-Ranges: bytes`；越界 `416`；无 Range 全量 200 |
| PDF | pdf | `application/pdf` inline |
| 文本/代码 | txt/md/log/json/yml/yaml/js/ts/jsx/tsx/py/go/java/c/cpp/h/sh/css/html/csv/xml/ini/conf/sql/rb/php/rs/toml | JSON `{ kind:'text', language, content, sizeBytes, truncated }`（上限 1 MB，超出 `413 preview_too_large`） |
| Markdown | md | JSON `{ kind:'markdown', html, sizeBytes }`，`html` 由服务端渲染并净化 |
| SVG | svg | `415 preview_unsupported`（内联 SVG 可执行脚本，故意不预览） |
| 其它 | — | `415 preview_unsupported` |

- 图片/PDF/视频上限 200 MB；文本/Markdown 1 MB
- 需要存储策略：解析不到 → `412 storage_not_configured`；文件与远端都没有 → `404 not_found`
- **Markdown 防 XSS**：先整体 HTML 转义，再只识别白名单语法（标题/粗体/斜体/行内代码/围栏代码/列表/引用/链接/表格）；链接协议仅 `http|https|mailto`；输出后再过 `<script|<iframe|<object|javascript:|on*=` 断言，命中则报错

### GET `/api/files/preview/meta?path=`
→ `{ kind, name, sizeBytes, mime, language?, orientation?, strategy: { type, name }, previewable, reason? }`
- 问询用途：不可预览时返回 `previewable:false` + 中文 `reason`（不抛 415）

## P3-4 管理端分享（`/api/admin/shares`，需管理员会话）

### GET `/api/admin/shares?status=&email=&limit=`
→ `{ items: [...], total }`，item 字段：`id, token, email, name, path, isDir, expiresAt, maxDownloads, downloadCount, allowPreview, hasCode, status, createdAt, revokedAt`
- `status` 过滤可选值同 P3-1；`limit` 默认 50、上限 200

### DELETE `/api/admin/shares/:id` → `{ ok: true }`，写审计 `share_revoke`

## P3-5 页面路由

| 路由 | 页面 | 说明 |
|---|---|---|
| `/share/:token`、`/s/:token` | `public/share.html` | 公开分享页，token 由前端从路径解析 |
| `/files` | `public/files.html` | 新增分享弹窗与预览弹层 |
| `/admin/shares.html` | `public/admin/shares.html` | 管理端分享列表与撤销 |

## P3-6 审计动作

分享相关新增 `share_create`、`share_revoke`（`server/services/audit.js` 白名单已扩展）。

---

# P4 追加：传输增强（本段优先于上文冲突项）

## P4-0 新增错误码

| HTTP | code | 场景 |
|---|---|---|
| 404 | `upload_session_not_found` | 分片会话不存在 / 已清理 / 非本人 |
| 410 | `upload_session_expired` | 分片会话过期（24h） |
| 400 | `upload_part_out_of_range` | 分片序号越界 |
| 409 | `upload_incomplete` | 分片未齐就 complete / 会话已完成又传片 |
| 413 | `zip_too_large` | 打包或解压体积超上限（5 GB） |
| 400 | `zip_too_many_entries` | 条目数超上限（10000） |
| 400 | `zip_invalid` | 非 zip / 截断 / 中央目录缺失 |
| 400 | `zip_slip_blocked` | 包内含 `../`、绝对路径、反斜杠或符号链接，整包拒绝 |

## P4-1 分片上传 `/api/uploads`（需登录）

| 接口 | 说明 |
|---|---|
| `POST /api/uploads/init` | body `{ parentPath, name, sizeBytes, chunkSize?, overwrite? }`；`chunkSize` 默认 8 MiB（1–64 MiB），`sizeBytes` ≤ 100 GB；201 `{ uploadId, chunkSize, totalChunks, received: [], expiresAt }`；同 (parentPath,name) 已有 active 会话时幂等返回同一会话；只读策略 → 403 `strategy_readonly`；同名已存在且未 `overwrite=1` → 409 `conflict` |
| `GET /api/uploads` | 本人未过期会话：`{ items: [{ uploadId, parentPath, name, sizeBytes, chunkSize, totalChunks, receivedCount, received, expiresAt, status }] }` |
| `GET /api/uploads/:id` | `{ item: {...同上, missing: [序号] } }`（断点续传依据）；他人/不存在 → 404 |
| `PUT /api/uploads/:id/part/:index` | **请求体是分片原始二进制**（非 multipart）；非末片大小必须等于 `chunkSize`（不符 400 `invalid_input`，details 带 `expected/actual`）；200 `{ index, receivedCount, totalChunks }`；重复上传同 index 幂等覆盖 |
| `POST /api/uploads/:id/complete` | 校验分片齐全（缺片 409 `upload_incomplete` + `missing`）→ 流式合并 → 校验总字节 → 配额三连（413/409/429）→ `driver.writeFromTemp` 落策略 → 201 `{ item, quota }`；重复调用幂等返回同一结果 |
| `DELETE /api/uploads/:id` | 中止并清理临时目录 → `{ ok: true }`（幂等） |

- 会话 24 小时过期；`server/index.js` 启动时与每小时 `sweepExpired()` 清理过期会话与临时目录
- 临时目录：`<STORAGE_ROOT>/.tmp/chunks/<uploadId>/`
- 同一会话并发 complete 由内存锁串行化，第二个请求返回 409
- `completed` 会话行保留（用于幂等），列表与清理均排除

## P4-2 打包下载 `POST /api/files/zip`（需登录）

body `{ paths: [...] }`，返回 **zip 二进制流**：
- 响应头：`Content-Type: application/zip`、`Content-Disposition: attachment; filename*=UTF-8''<name>.zip`、`X-Archive-Entries: <n>`
- 目录递归展开、按 path 去重；写响应头之前完成预检（条目 > 10000 → `zip_too_many_entries`；未压缩总字节 > 5 GB → `zip_too_large`；路径不存在 → 404）
- ZIP 内路径为相对公共父目录的路径，UTF-8 文件名（flag bit 11）；deflate(8)，已压缩媒体可 store(0)
- 客户端断开时 `writer.abort()` 释放上游流

## P4-3 预检 `POST /api/files/zip/plan`（需登录）

body `{ paths }` → `{ files: [{ name, path, sizeBytes }], totalBytes, entries, tooLarge }`

## P4-4 在线压缩 `POST /api/files/compress`（需登录）

body `{ paths, targetPath?, name? }` → 201 `{ item: { name, path, type:'file', sizeBytes, mime, updatedAt, storageId }, entries }`
- 目标目录默认取首个条目所在目录；`name` 默认 `<首条目名>.zip`；同名 → 409 `conflict`
- 上限同打包；写临时 zip → `writeFromTemp` 落策略 → `insertNode`（mime `application/zip`）→ 记上传流量 → 审计 `compress`
- 只读目标 → 403 `strategy_readonly`；配额 413/409/429

## P4-5 解压 `POST /api/files/extract`（需登录）

body `{ path, targetPath? }` → 201 `{ extracted, skipped: [{name, reason}], totalBytes }`
- 只接受 `.zip`；`targetPath` 默认 zip 所在目录（不存在时自动补建目录节点）
- **zip slip 防护**：条目名含 `..` 段、以 `/` 或盘符开头、含反斜杠、符号链接条目、空名 → 400 `zip_slip_blocked`（整包中止，不落任何文件）
- 上限：条目 ≤ 10000、解压总字节 ≤ 5 GB、单条目 ≤ 单文件配额
- 先全量解到 `<STORAGE_ROOT>/.tmp/extract/<id>/` 校验通过后再逐个落策略；同名跳过并在 `skipped` 返回
- 只读目标 → 403 `strategy_readonly`；审计 `extract`

## P4-6 ZIP 实现说明（`server/lib/zip.js`）

- 自研 ZIP32（不引依赖）：CRC32 查表、store/deflate 流式、UTF-8 flag(0x800)、数据描述符(bit3)、Central Directory + EOCD
- Reader：EOCD → Central Directory → Local File Header，`createInflateRaw` 流式解压并校验 CRC/尺寸
- ZIP64（>4 GiB）与 AES 加密不支持：超出按上限拒绝（`zip_too_large` / `zip_invalid`）
- 兼容性实测：`unzip -t` 通过；能被系统 `zip` 生成的包反向读回（含中文目录名）

---

# P6 追加：控制台账号来源与本地账号（本段优先于上文冲突项）

## §P6 控制台：账号来源与本地账号

### P6-0 概念与存储

- **账号来源 `userSource`**：站点级设置，存 SQLite `settings` 表，key **`userSource`**，取值 `"supabase"` | `"volume"`；**缺省（无该行）= `"supabase"`**，保持现网行为不变。
  - `supabase`：登录 / 建号走 Supabase，会话携带 `accessToken` / `refreshToken`。
  - `volume`：本地数据卷账号体系，密码以 scrypt 落 `users.passwordHash`，会话为本地签名 cookie（`local:true`，token 字段为 `null`）。
- 切换时间落 `settings` key **`userSourceChangedAt`**（ISO 字符串，未切换为 `null`）。
- 读写统一走 `server/services/user-source.js`：`getUserSource()` / `setUserSource(src)` / `isVolumeSource()` / `getSwitchedAt()` / `setSwitchedAt(iso)`；其它模块只通过它读，不散写 SQL。
- 本地密码格式：`scrypt$N$r$p$saltB64$hashB64`，salt 16B、hash 64B，`N=16384 r=8 p=1`（`hashLocalPassword` / `verifyLocalPassword`）。

### P6-1 数据模型变更（`users` 表加列，不新建表）

| 列 | 类型 | 说明 |
|---|---|---|
| `passwordHash` | TEXT | scrypt 派生值；有值即本地账号（`source=local`），空 = Supabase 账号 |
| `status` | TEXT NOT NULL DEFAULT `active` | `active` \| `banned`；与老列 `disabled` 同步：`disabled=1` ⇔ `status='banned'`。**读取以 `status` 为准**，写入两列都写 |
| `registeredAt` | TEXT | 注册/创建成功时间；老库迁移用 `createdAt` 回填 |

`db.js` 的 `migrate()` 用 `PRAGMA table_info(users)` 检测缺列后 `ALTER TABLE ADD COLUMN`，并回填 `registeredAt`、按 `disabled` 回填 `status`；已有 `disabled` 与 `status` 互相校正。文件节点仍以 email 为归属键，沿用现有 `nodes` 记录。

### P6-2 账号来源管理接口（挂在 `/api/admin`，需管理员会话）

#### GET `/api/admin/user-source`
200：
```json
{
  "userSource": "supabase",
  "default": "supabase",
  "storage": { "table": "settings", "key": "userSource" },
  "counts": { "total": 12, "localAccounts": 3 },
  "switchedAt": "2026-11-15T01:51:08.249Z"
}
```
- `counts.total`：用户总数；`counts.localAccounts`：有 `passwordHash` 的用户数。
- `switchedAt`：最近一次切换时间（`userSourceChangedAt`），未切换为 `null`。

#### PUT `/api/admin/user-source`
body `{ "source": "supabase"|"volume", "confirm": true }`
- 200：`{ "ok": true, "switchedFrom": "supabase", "switchedTo": "volume", "changedAt": "…" }`（未发生切换时幂等返回当前状态，`changedAt` 为现有值）。
- 400 `invalid_input`：
  - `source` 非法 → `details.field = "source"`；
  - `confirm` 不为 `true` → `details.field = "confirm"`。
- 生效时写审计 action `user_source_switch`，detail 形如 `"supabase->volume"`，并把 `changedAt` 落 `settings.userSourceChangedAt`。

### P6-3 登录与会话分流

#### POST `/api/auth/login`
按 `getUserSource()` 分流：
- **supabase**：维持现状（Supabase 密码登录，会话带 `accessToken` / `refreshToken`）；未配置 Supabase → 412 `supabase_not_configured`。
- **volume**：本地校验 scrypt 密码；成功后更新 `lastLoginAt`（`registeredAt` 已在建号时落库），写会话 `{ v:1, email, accessToken:null, refreshToken:null, dev:false, local:true, exp: now+7d }`，沿用同一套 HMAC 签名 cookie `r6t5_sid` 与中间件，不新造 session 机制。**volume 模式下 Supabase 未配置不再抛 412。**

**错误语义（硬性要求）：**

| 场景 | HTTP | code | message |
|---|---|---|---|
| 账号不存在 | 401 | `invalid_credentials` | 「邮箱或密码错误」 |
| 密码错误 | 401 | `invalid_credentials` | 「邮箱或密码错误」 |
| 已封禁（`status='banned'` / `disabled=1`） | 403 | `account_banned` | 「账号已被封禁，请联系管理员」 |

- 「账号不存在」与「密码错误」对外**完全一致**：相同 status / code / message（逐字节），不通过 code/message/details 暴露账号是否存在；内部分流只体现在审计 detail（`local_no_user` / `local_bad_password`）与服务端日志。
- 沿用现有 IP+邮箱 5 次 / 10 分钟限流（`loginFails` 等），本地登录同样计数。

#### POST `/api/auth/signup`
- **volume 模式**：拒绝 → 409 `not_supported_in_source`，message「当前为数据卷账号模式，请由管理员创建账号」。
- **supabase 模式**：维持现有 Supabase 自助注册逻辑（仍受 `allowSignup` 开关约束）。

#### POST `/api/auth/dev-login`
保持 `DEV_AUTH` 开关行为不变（`DEV_AUTH=1` 才可调用），不受来源切换影响。

#### 会话解析 `resolveUser()`（`server/middleware/auth.js`）
- 会话带 `local:true`（或当前 `userSource==='volume'`）时**跳过 Supabase access token 校验**；
- **每次请求都查库校验 `status` / `disabled`**：被封禁立即 403 `account_banned`（不依赖会话过期，这是「封禁立刻让既有 session 失效」的机制）；
- 用户行不存在 → 401 `unauthorized`（账号不存在）。

#### GET `/api/setup/status`
- `userSource === 'volume'` 时**跳过 supabase 检查**：不因未配 Supabase 卡在 `next='supabase'`。
- 返回体新增 `userSource` 字段；`checks.supabase` 在 volume 模式语义为「不需要」，返回 `true` 并加 `checks.supabaseRequired: false`；volume 模式 hint 不出现 Supabase 字样。

### P6-4 管理端用户操作（`/api/admin/users`，需管理员会话）

#### GET `/api/admin/users`
每项补充字段：

| 字段 | 说明 |
|---|---|
| `status` | `active` \| `banned` |
| `registeredAt` | 注册/创建时间；空值为 `null` |
| `source` | `local`（有 `passwordHash`）否则 `supabase` |
| `lastLoginAt` | 保持原字段；空值为 `null`（前端显示「无记录」） |

#### POST `/api/admin/users`
- **volume 模式**：本地建号。email 唯一（重复 → 409 `conflict`）、password scrypt 落库、`displayName`、`groupId`、`status=active`、`registeredAt=now`；写审计 `user_create`（detail `local`）。201 `{ item }`。
- **supabase 模式**：维持现有 Supabase 建号逻辑（`adminCreateUser`），不假装本地建号；Supabase 未配置 → 412 `supabase_not_configured`。审计 detail `supabase`。

#### POST `/api/admin/users/:id/password`
- **volume 模式**：本地改密，写审计 `user_password` → 200 `{ ok:true, item }`。
- **supabase 模式**：409 `not_supported_in_source`，message「Supabase 账号密码请在 Supabase 侧修改」（与该用户是否带本地 hash 无关，按当前来源判定）。

#### PATCH `/api/admin/users/:id`
- 支持 `status: "active"|"banned"`（与 `disabled` 同步写入）：封禁写审计 `user_ban`，解封写 `user_unban`。
- 保留现有 `groupId` / `displayName` 行为；兼容老字段 `disabled`（true ⇔ banned）。
- 200 `{ item }`。

#### DELETE `/api/admin/users/:id?deleteFiles=0|1`（**语义改为真正删号**）
- `deleteFiles=0`：仅删账号，保留文件节点与存储对象。
- `deleteFiles=1`：删账号并删除其文件目录——先清空该 email 名下所有 nodes（含回收站），再通过现有存储驱动（`server/services/storage`）删除物理对象与目录，复用 admin-trash 的清理方式，不另写一套物理删除；返回 `{ deletedFiles: { nodes, bytes } }`。
- **删账号 = 删除 `users` 行**（本地账号彻底消失）。若该用户是 Supabase 账号（无 `passwordHash`），**只删本地记录**，响应带 `supabaseUserKept: true`，message 说明「Supabase 中的用户未被删除」。
- 同时清理该账号的附属本地记录：`shares`、`share_hits`、`app_passwords`、`upload_sessions`、`traffic`。
- 写审计 `user_delete`，detail 含 `files:kept` / `files:deleted`（Supabase 账号另带 `supabase:kept`）。
- 删号后既有会话失效：users 行删除后 `resolveUser` 返回 401（被封禁则 403），不会出现 500。

### P6-5 新增错误码

| HTTP | code | 场景 |
|---|---|---|
| 403 | `account_banned` | 账号被封禁（登录或既有会话每次请求校验） |
| 409 | `not_supported_in_source` | 当前账号来源不支持该操作（volume 自助注册；supabase 侧本地改密等） |

### P6-6 审计动作白名单补充

`server/services/audit.js` 的 `VALID_ACTIONS` 新增：`user_ban`、`user_unban`、`user_delete`、`user_create`、`user_password`、`user_source_switch`。不在白名单的动作旧实现会被归一化成 `login`，以上动作均已显式入列，可按 `/api/admin/audit?action=<action>` 检索到原始动作名。

### P6-7 未覆盖 / 沙箱限制

- 沙箱内无真实 Supabase：supabase 分支只验证了「未配置时的行为」（412 / 跳过 / 409），真实 Supabase 密码登录、建号、改密、远端用户保留等链路需在有 Supabase 实例的环境复测。

