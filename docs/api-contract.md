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
| `invalid_credentials` | 401 | 账号或密码错误 |
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
服务端流程：校验 `users.passwordHash`（scrypt）→ 写 `r6t5_sid` 本地会话 Cookie → 更新 `lastLoginAt` → 记 audit `login`。
密码错误 → 401 `invalid_credentials`。连续失败 5 次/10 分钟 → 429 `rate_limited`。

### POST `/api/auth/signup`（仅当 `settings.allowSignup=true`）
`{ email, password, passwordConfirm }` → 本地建号（受用户组 `allowSelfSignup` 限制）；返回 `{ ok:true }`。关闭时 403 `forbidden`。

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
  "next": "storage",
  "hint": "请添加一条可用的存储策略",
  "link": "/admin/login",
  "linkLabel": "进入管理后台",
  "checks": { "storage": false, "groups": false, "site": false },
  "site": { "name": "R6T5 Drive", "publicUrl": "", "defaultGroupId": null, "isDefaultSite": true },
  "counts": { "users": 0, "groups": 1, "strategies": 0 }
}
```
`next` 取值与优先级（前者满足才检查后者）：
1. `storage` — 还没有可用的存储策略
2. `storage` — 无任何启用的存储策略
3. `groups` — 除 admin 外可用用户组 < 2（即 `groups` 表内 `is_default` 之外的组不足 2 个，含默认组）
4. `site` — `siteName` / `publicUrl` / `defaultGroupId` 仍为空或默认值
5. `ready` — 以上全过

`hint` 由服务端给中文文案（前端**只渲染这一条**，不要自己拼文案）：
- storage：`还没有可用的存储策略，请管理员先添加一条`
- groups：`用户组不足 2 个，请管理员创建用户组`
- site：`站点信息仍是默认值，请补全站点名 / 对外地址 / 默认用户组`
- ready：`配置完成，可以使用邮箱登录`

### GET `/api/admin/setup/status`（需管理员）
`userSource` 恒为 `"volume"`；`checks` 只有 storage/groups/site 三项。

---

## 3. 管理端 · 账号

Supabase 托管账号模式已下线：不再提供 `/api/admin/supabase`、`/api/admin/user-source`、`POST /api/admin/users/sync`；账号统一为数据卷本地账号（scrypt 密码），由「用户」页管理。

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
> **P6 起语义改为真正删号**，详见 §P6-4。`?deleteFiles=0|1` 控制是否连带删除文件节点与物理对象；账号为数据卷本地账号，无远端记录需保留。旧版「仅禁用用户」的行为已废弃。

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
server/routes/{setup,auth,admin-auth,admin-overview,admin-users,admin-groups,admin-storage,admin-blobs,admin-settings,admin-audit,admin-trash,files,trash,account,shares}.js
server/services/{blobs,quota,traffic,audit,nodes}.js
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

### POST `/api/files/embed/sign`（需登录，Body `{ path }`）
→ `{ ok, url, provider:'gdocs'|'m365', expiresAt }`
- 仅 Office 与 PDF；`none` 时 `400 preview_disabled`；对外地址为本机/内网 → `400 embed_requires_public_url`
- 写审计 `embed_open` 与日志 `CHG [embed]`

### GET `/api/embed/file?t=<令牌>`（免登录）
- 随机短期令牌（内存保存，10 分钟过期，重启即失效，不含邮箱与路径明文）
- 仅 `inline` 输出 Office/PDF，`Cache-Control: no-store`、`X-Robots-Tag: noindex`；无效/过期 → `401 embed_token_invalid`
- meta 额外字段：Office 返回 `kind:'office'` + `openWith`（`none|gdocs|m365`），PDF 返回 `pdfMode`（`pdfjs|native`）


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

# P6：账号体系（Supabase 已下线，仅数据卷本地账号）

- 账号来源固定为 `volume`：`getUserSource()` 恒返回 `"volume"`，`PUT /api/admin/user-source` 已移除。
- 登录 `POST /api/auth/login`：校验 `users.passwordHash`（scrypt `scrypt$N$r$p$salt$hash`）→ 写本地签名会话 Cookie `r6t5_sid`（`accessToken=null`、`local:true`）→ 更新 `lastLoginAt` → 审计 `login`。密码错误 401 `invalid_credentials`，连续失败 5 次/10 分钟 429 `rate_limited`。
- 自助注册 `POST /api/auth/signup`：仅当存在 `allow_self_signup=1` 的用户组时开放；否则 403 `forbidden`。`GET /api/auth/signup-config` 恒返回 `source:"volume"`。
- `GET /api/setup/status`：`userSource` 恒 `"volume"`，`checks` 仅 `storage/groups/site`，流程从 `storage` 开始。
- 已移除：`/api/admin/supabase`、`/api/admin/user-source`、`POST /api/admin/users/sync`。
- 管理端用户操作：`GET/POST /api/admin/users`、`POST /api/admin/users/:id/password`、`PATCH /:id`（封禁/解封）、`DELETE /:id?deleteFiles=0|1`（真正删号，可选连带删文件）。
- 用户表列：`passwordHash`、`status(active|banned)`、`registeredAt`；老库由 `migrate()` 补列并回填。

## §P7 用户组自助注册 / sudo / 空间单位

### §P7-1 用户组字段（`groups` 表）

**列名（snake_case，落库）↔ JSON（camelCase，对外）映射：**

| 数据库列 | JSON 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `allow_self_signup` | `allowSelfSignup` | 布尔（0/1） | `0` | 是否允许该组参与 volume 自助注册分配 |
| `is_sudo` | `isSudo` | 布尔（0/1） | `0` | sudo 用户组标记：组成员凭普通用户会话即可进入管理控制台 |

**迁移（`db.migrate()`）**：用 `PRAGMA table_info(groups)` 检测缺列，自动 `ALTER TABLE ADD COLUMN`；老库两列默认 `0`，语义不变。`schema.sql` 新库直接带这两列。

**注册分配组 SQL**（volume 自助注册取组，`server/routes/auth.js` `pickSignupGroup()`）：

```sql
SELECT * FROM groups
WHERE allow_self_signup = 1
ORDER BY createdAt ASC, id ASC
LIMIT 1
```

即：开启自助注册的组中，按 `createdAt` 最早（`id` 兜底）分配；无命中组即注册关闭。

**管理端组接口**（`/api/admin/groups`，`server/routes/admin-groups.js`）：
- `POST` / `PATCH` 入参支持 `allowSelfSignup` / `isSudo`（布尔）；`serialize` 出参以布尔暴露。
- `PATCH` 中 `isSudo` 或 `allowSelfSignup` 发生变化时写审计 `group_update`，`detail` 形如 `sudo:on`、`signup:off`（两者都变则逗号拼接）；响应返回最新 `item`。

### §P7-2 注册（volume 自助注册）

#### `POST /api/auth/signup`

**volume 模式**，body：`{ email, password, passwordConfirm }`。

| 步骤 | 规则 | 失败响应 |
|---|---|---|
| 邮箱格式 | 沿用现有 `EMAIL_RE` | 400 `invalid_input`，`details.field='email'`，message「邮箱格式不正确」 |
| 密码长度 | `password` ≥ 8 位 | 400 `invalid_input`，`details.field='password'`，message「密码至少 8 位」 |
| 两次一致 | `passwordConfirm === password` | 400 `invalid_input`，`details.field='passwordConfirm'`，message「两次输入的密码不一致」 |
| 开放组 | 无开启 `allow_self_signup` 的组 | 403 `signup_closed`，message「当前未开放自助注册」 |
| 邮箱已存在 | 含已封禁重名账号 | 400 `invalid_signup`，message 统一「注册信息无效」；响应**不**出现 duplicate/exists/已存在/已注册等字眼，内部仅写审计 `signup`（detail `signup_duplicate`） |

**成功**：在分配组下建本地账号（scrypt 密码、`status=active`、`registeredAt=now`、`displayName` 默认空），直接建会话（复用 volume 登录那套 `{v:1, email, local:true, dev:false, exp:+7d}` + `setUserCookie`），写审计 `signup`，返回 **201** `{ ok:true, user: publicUser(...), setup:{ next:'ready' } }`。

**限流（同 IP 内存令牌桶）**：
- 参数：容量 **5**，每分钟补 **1** 个令牌；按 `req.ip || req.socket.remoteAddress` 取 IP。
- 通过参数校验的尝试（含邮箱已存在、注册关闭）都计数；参数非法（格式/长度/两次不一致）不计入桶。
- 超限 → 429 `rate_limited`，message「注册尝试过多，请稍后再试」。
- 桶为进程内存态，重启即重置；不跨实例共享。

**supabase 模式**：保持现有行为（`allowSignup` 设置 + Supabase `/auth/v1/signup`），不建本地号、不返回 201 本地用户结构。

#### `GET /api/auth/signup-config`

前端据此决定是否展示「注册」入口：

```json
{ "available": true, "minPasswordLength": 8, "source": "volume", "reason": "ok" }
```

| 字段 | 取值 |
|---|---|
| `available` | 布尔：是否开放注册 |
| `minPasswordLength` | `8` |
| `source` | `'volume'` \| `'supabase'` |
| `reason` | `'ok'` \| `'closed'`（volume 无开放组）\| `'admin_disabled'`（supabase 未开 `allowSignup`） |

#### 错误码（`server/lib/errors.js`）

| HTTP | code | message | 场景 |
|---|---|---|---|
| 403 | `signup_closed` | 当前未开放自助注册 | volume 无开启自助注册的组 |
| 400 | `invalid_signup` | 注册信息无效 | 邮箱已存在 / 重名封禁账号（统一文案，不泄露存在性） |
| 429 | `rate_limited` | 注册尝试过多，请稍后再试 | 同 IP 令牌桶超限 |

### §P7-3 sudo 用户组与空间单位

#### sudo 判定（`server/middleware/auth.js`，`resolveAdminAccess`）

判定顺序：
1. **管理密码会话**有效 → 通过，`via='password'`；
2. 否则读 user 会话 → 查库得 user 与其 group（`resolveGroup`），若 `group.is_sudo === 1` 且 user 未被封禁 → 通过，`via='sudo'`，挂 `req.sudoUser = { email, groupId, groupName }`；
3. 都不是：`requireAdminApi` 对普通登录用户返回 403 `forbidden`，未登录返回 401 `unauthorized`；`requireAdminPage` 返回现有 403 HTML。

**立即生效**：每次请求都查库（不缓存组标记），组改 `is_sudo` 后下一个请求即生效；被移出 sudo 组的下一个请求即 403。

- `GET /api/admin/session`：密码会话返回老结构 + `via:'password'`；sudo 会话返回 `{ ok:true, admin:{ via:'sudo', email, groupId, groupName } }`；都不是 → 401。
- `/admin` 根路径重定向（`server/app.js`）：admin 会话**或** sudo 用户会话都跳 `/admin/home.html`，否则 `/admin/login`；`/admin/*`（除登录页）页面守卫允许 sudo。
- 普通用户登录成功后访问 `/api/admin/*` 仍 403；sudo 用户 200。
- 审计：sudo 进入管理面板写 `admin_login`，detail `sudo:<email>`。

#### 空间单位（`server/lib/bytes.js`，1024 进制，BigInt 精确换算）

单位表 `UNITS = ['B','KB','MB','GB','TB','PB','EB']`，全部 1024 进制。

| 导出 | 说明 |
|---|---|
| `parseSizeToBytes(value, unit)` | → BigInt；`value` 可为数字/十进制字符串（允许小数，如 `"1.5"`、`"0.25"`）；十进制字符串精确换算，不先 `Number()` 再乘；非法值/负数/0 抛 400 `invalid_input` |
| `MAX_SQLITE_INT` | `9223372036854775807n`（int64 有符号上限，约 8 EB） |
| `assertMaxSqliteInt(bytes, field)` | 超上限抛 400 `invalid_input`，message「超出 SQLite INTEGER 上限（约 8 EB）」，`details { field, max: '9223372036854775807' }`；不截断、不改 REAL 存储 |
| `formatSize(bytes)` | 人类可读，如 `1.5 TB`、`200 MB`、`0 B`；支持 BigInt/数字/十进制字符串 |
| `toByteString(bytes)` | 十进制字符串（供 JSON，避免 Number 精度丢失） |

**组限额入参（两种写法二选一，都实现）**：
- 旧写法：`spaceLimitBytes` / `maxFileSizeBytes` / `traffic7dLimitBytes`（数字或十进制字符串）；
- 新写法：`spaceLimit: { value, unit }` / `maxFileSize: { value, unit }` / `traffic7dLimit: { value, unit }`。

换算成 BigInt → 校验 ≥1 且 ≤ `MAX_SQLITE_INT` → 以十进制字符串绑定 INTEGER 列。

**出参（`serialize`）破坏性变更**：三个 `*Bytes` 字段改为**十进制字符串**（如 `"1610612736"`），并新增 `spaceLimitText` / `maxFileSizeText` / `traffic7dLimitText` 人类可读字符串。

**配额与拦截比较**（`quota.js` / `files.js` / `chunks.js` / `archive.js` / `dav.js`）：限额与已用均以 BigInt 读取/汇总，比较统一走 BigInt（`BigInt(size) > limit`）；`/api/me` 等配额响应保留原 `*Bytes` 字段名但值为十进制字符串，并新增 `spaceLimitText/usedText/spaceRemainingText/maxFileSizeText/traffic7dLimitText/traffic7dUsedText/traffic7dRemainingText`。无组默认值：10 GiB 空间 / 2 GiB 单文件 / 5 GiB 流量（BigInt 常量）。

**上限示例**：1 EB = `1152921504606846976` 字节；16 EB（=2^64）超上限 → 400 `invalid_input`，`details.max='9223372036854775807'`。

#### 审计动作白名单补充

`server/services/audit.js` 的 `VALID_ACTIONS` 新增：`signup`、`group_update`。

## §P7-4 版本发布与更新检查（管理端）

### 版本与发布元数据（仓库根）

| 文件 | 说明 |
|---|---|
| `VERSION` | 单行构建号（格式 `YYYYMMDDx`，例如 `20261115a`）。`GET /api/admin/update-status` 以它为「本地版本」 |
| `latest.json` | 发布元数据：`version` / `issueNumber` / `commentId` / `commentUrl` / `publishedAt` / `upgradeCommand` / `notes` |
| `tools/release.mjs` | 发版脚本：读 `VERSION` → 用 GitHub API 建 issue（标题 `Release <version>`）→ 在 issue 下建一条发布评论 → 把 `issueNumber`/`commentId`/`commentUrl`/`publishedAt` 写回 `latest.json`。PAT 只从环境变量 `GITHUB_TOKEN` 读取，不入库；支持 `--dry-run`（不发网络请求，打印将创建的 issue 正文与 latest.json 内容） |

三者对应关系：issue 标题携带版本号 → issue 下唯一一条发布评论承载发布说明 → `latest.json` 用 `issueNumber` + `commentId` 指回它们，控制台据此渲染「关于 / 更新」卡片。

### `GET /api/admin/update-status`（管理员密码会话或 sudo 会话）

- 远端来源：`https://raw.githubusercontent.com/TanchiPanda/r6t5-drive/main/latest.json`，超时 5s，进程内缓存（成功 5 分钟 / 失败 60 秒）。
- 成功（HTTP 200）：

```json
{ "checked": true,
  "current": { "version": "20261115a", "builtAt": "<ISO>", "serverTime": "<ISO>" },
  "latest": { "version": "...", "issueNumber": 1, "commentId": 2, "commentUrl": "...",
              "publishedAt": "...", "upgradeCommand": "docker compose pull && docker compose up -d",
              "notes": "..." },
  "hasUpdate": true, "cached": false }
```

- 远端不可达 / 非 200 / JSON 非法（**仍是 HTTP 200**，不抛 5xx、前端不弹红字错误）：

```json
{ "checked": false, "reason": "network" | "http_<code>" | "invalid_json",
  "current": { "version": "...", "builtAt": "...", "serverTime": "..." }, "cached": false }
```

- `hasUpdate` 判定：远端 `version` 与本地 `VERSION` **字符串不等**即 true（构建号不是语义化版本，不做大小比较）。

## §P8-1 品牌与站点外观

### 配置 key（`settings` 表，全部可空 = 回落默认静态资源）

| settings key | 对应 slot / 字段 | 回落默认 |
|---|---|---|
| `brand.logoLightUrl` | `logoLightUrl` / `logoLight` | `/assets/favicon.svg` |
| `brand.logoDarkUrl` | `logoDarkUrl` / `logoDark` | `/assets/icons/favicon.svg` |
| `brand.faviconUrl` | `faviconUrl` / `favicon` | `/assets/favicon.svg` |
| `brand.icon192Url` | `icon192Url` / `icon192` | `/assets/icons/favicon.svg` |
| `brand.iconLargeUrl` | `iconLargeUrl` / `iconLarge` | `/assets/icons/favicon.svg` |
| `brand.sidebarHtml` | `sidebarHtml`（落库前已清洗） | `null`（不渲染） |

品牌上传文件落在 `data/branding/`（目录取 `path.dirname(ENV.DB_PATH)` 下的 `branding/`，`mkdirSync recursive`；`DB_PATH` 指向 `/tmp` 时品牌文件随之隔离）。对外 URL 统一为本站相对路径 `/branding/<slot>-<hash8>.<ext>`。

### 管理端接口（挂在 `/api/admin/branding`，管理员密码会话或 sudo 会话）

- `GET /api/admin/branding` →
  `{ logoLightUrl, logoDarkUrl, faviconUrl, icon192Url, iconLargeUrl, sidebarHtml, sidebarHtmlSanitized, defaults:{...是否回落}, updatedAt }`。
- `PATCH /api/admin/branding`：body 支持上述 5 个 URL 字段 + `sidebarHtml`（可只传部分）。
  - URL 字段必须是 `http(s)://` 或本站根相对路径 `/` 开头（拒绝 `//` 协议相对）；长度 > 512 拒绝。
  - `sidebarHtml` 落库前过白名单清洗；响应 `item.sidebarHtml` 为清洗后串，`sidebarHtmlRaw` 为原始串（便于前端提示「部分内容已移除」）。
  - 写审计 `settings_update`，detail `branding:<patch|upload:<slot>|clear:<slot>>`。
- `POST /api/admin/branding/upload?slot=logoLight|logoDark|favicon|icon192|iconLarge`：multipart 单文件字段 `file`。
  - 允许扩展名 `svg / png / ico`；**大小上限 512KB**，超限 413 `payload_too_large`。
  - **文件头（magic）校验**，不只信扩展名 / mimetype：
    - PNG：头 `89 50 4E 47`；
    - ICO：头 `00 00 01 00`；
    - SVG：内容必须能解析出 `<svg`，且不能是 `<!doctype html>` / `<html>` 伪装文档。
  - 扩展名与 magic 不一致 → 400 `invalid_input`。成功 201 `{ ok:true, url, slot }` 并写回对应 settings key。
- `DELETE /api/admin/branding/:slot`：清空该 slot（回落默认），返回 `{ ok:true, item }`。

### 公开接口（免登录）

- `GET /api/branding` → `{ siteName, logoLightUrl, logoDarkUrl, faviconUrl, icon192Url, iconLargeUrl, sidebarHtml }`；`sidebarHtml` 为清洗后版本，无配置时各字段为 `null`，前端自行回落默认资源。
- `GET /branding/:name`：服务 `data/branding/` 下文件；禁止路径穿越（拒绝 `..`、`/`、`\`），越界 404。
- `GET /branding/favicon`：有配置 302 到配置值，否则 302 到 `/assets/favicon.svg`。
- `GET /branding/logo-light`：有配置 302 到 `logoLightUrl`，否则 302 到 `/assets/favicon.svg`。
- `GET /branding/logo-dark`：有配置 302 到 `logoDarkUrl`，否则 302 到 `/assets/icons/favicon.svg`。
- `GET /manifest.webmanifest`（`application/manifest+json`）：`name/short_name` 取 `siteName`，`start_url:"/"`，`display:"standalone"`，`background_color:#0e1512`、`theme_color:#4a9e6e`（tokens.css 深色主色）；`icons` 含 192 / 512 两条，src 取 `icon192Url`/`iconLargeUrl`（互为兜底，再回落默认），size 字段按 192 / 512 布局标注。

### 侧边栏 HTML 清洗规则（`server/lib/html-sanitize.js`，前端 `R6T5.sanitizeSidebarHtml` 同规则双保险）

- 允许标签白名单：`p br strong em a span img h3 h4 ul li`。
- 整体移除危险标签及其内容：`script iframe object embed style form link meta`。
- 剔除所有 `on*` 事件属性与 `style` 属性；非白名单属性一律丢弃。
- `a[href]`：仅允许 `http(s)://`，否则剔除该链接（保留文本）。
- `img[src]`：允许 `http(s)://` 且域名在白名单（`raw.githubusercontent.com`、`*.githubusercontent.com`、`*.doubaocdn.com`），或本站根相对路径 `/...`；**一律拒绝** `data:`、`javascript:`、`blob:`、`vbscript:` 与协议相对 `//`；无合法 src 的 `img` 整体剔除。
- 白名单域名后缀常量集中在 `ALLOWED_IMG_HOST_SUFFIXES`（前端 `BRAND_IMG_SUFFIXES`），可配。

### 错误码

| 状态 | code | 场景 |
|---|---|---|
| 400 | `invalid_input` | 未知 slot / 空文件 / 扩展名不允许 / magic 与扩展名不一致 / SVG 缺 `<svg` 或为 HTML 伪装 / URL 非法协议或非本站路径 |
| 400 | `invalid_input` | URL 长度 > 512 |
| 413 | `payload_too_large` | 上传文件 > 512KB |
| 401 | `unauthorized` | 未登录访问 `/api/admin/branding` |

## §P8-2 注册策略 / SMTP / 邮箱确认 / 验证码 / 第三方登录

### 配置 key（`settings` 表）

**注册策略**

| key | 取值 | 说明 |
|---|---|---|
| `signup.allowDomains` | 逗号 / 换行分隔域名列表 | 非空时只允许命中其中一条；`example.com` 精确匹配，`*.example.com` 匹配 apex 与任意一级子域；大小写不敏感 |
| `signup.denyDomains` | 同上 | 黑名单，**优先于白名单**命中即拒 |
| `signup.forbidSubAddress` | `'true'` / `'false'` | `'true'` 拒绝本地部分含 `+` 的子地址邮箱（如 `a+b@x.com`） |

**SMTP**

| key | 默认 | 说明 |
|---|---|---|
| `smtp.host` | — | SMTP 主机；为空视为未配置 |
| `smtp.port` | `587` | 端口号 |
| `smtp.username` | — | 账号；为空则跳过 AUTH |
| `smtp.password` | — | 密码；只落库，管理接口回显脱敏，绝不下发明文 |
| `smtp.secure` | `'false'` | `'true'` 隐式 TLS（直连 `tls.connect`，常见 465）；`'false'` 先明文 EHLO，支持 STARTTLS 则升级，不支持则明文回落 |
| `smtp.fromName` | — | 发信显示名（非 ASCII 走 RFC2047 编码） |
| `smtp.fromEmail` | — | 发信地址；与 host 共同判定 `configured` |
| `smtp.replyTo` | — | 回复地址；联系邮箱回落顺序 `replyTo → fromEmail → null` |
| `smtp.connTimeoutMs` | `10000` | 连接 / 读取超时（毫秒，下限 1000） |

**验证码（Turnstile 为主，预留 hCaptcha / reCAPTCHA）**

| key | 说明 |
|---|---|
| `captcha.provider` | `turnstile` / `hcaptcha` / `recaptcha` |
| `captcha.siteKey` | 前端公开站点 key（可下发） |
| `captcha.secretKey` | 服务端密钥（**永不下发**） |
| `captcha.onLogin` / `captcha.onSignup` / `captcha.onRecover` | `'true'` / `'false'`，各场景独立开关 |

**第三方登录（授权码流）**

| key | 说明 |
|---|---|
| `oauth.qq.appId` / `oauth.qq.appKey` | QQ 互联 |
| `oauth.logto.issuer` / `oauth.logto.clientId` / `oauth.logto.clientSecret` | Logto（复用 OIDC Discovery） |
| `oauth.oidc.issuer` / `oauth.oidc.clientId` / `oauth.oidc.clientSecret` / `oauth.oidc.scope` | 通用 OIDC |
| `oauth.redirectBase` | 回调基址；为空取请求 `origin` |

### 接口表

**公开（免登录）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/security-config` | 返回 `{ captcha:{provider,siteKey,onLogin,onSignup,onRecover}, signup:{forbidSubAddress,hasAllowList,hasDenyList} }`；**不含 secret** |
| GET | `/api/auth/confirm?token=xxx` | 邮箱确认结果页（HTML）。成功：用户置 `active`、令牌 `usedAt` 落库、写审计 `email_confirm`(detail=`link`)；失败：HTML「链接已失效」+ 联系邮箱（`replyTo → fromEmail`，无则「请联系站点管理员」），带复制邮箱按钮（`navigator.clipboard` + select 降级） |
| GET | `/api/auth/oauth/providers` | 仅列已配置 provider：`{ providers:[{id,label,startUrl}] }` |
| GET | `/api/auth/oauth/:provider/start` | 302 到授权页；`state` 签名存 HttpOnly Cookie。未配置 → 503 `integration_not_configured` |
| GET | `/api/auth/oauth/:provider/callback` | 换 token → 取 userinfo → 不存在则按注册策略建号（第三方邮箱视为已验证，直接 `active`）→ 建会话 → 302 `/files`；state 不符 400 HTML |

**管理端（挂 `/api/admin`，需管理员会话或 sudo）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/mail` | SMTP 脱敏快照：`configured,host,port,username,secure,fromName,fromEmail,replyTo,connTimeoutMs,contactEmail,passwordSet,passwordMasked`；密码只回 `****` + 末 2 位 |
| PATCH | `/api/admin/mail` | 部分更新；`password` 传空串 = 不修改，传新值 = 覆盖。写审计 `settings_update`(detail=`mail`) |
| POST | `/api/admin/mail/test` | body `{to}`，真发一封测试邮件；成功 `{ok,code,response}`，失败 502 `upstream_error` 且 `details.smtpCode` 存在 |
| GET | `/api/admin/security` | 注册策略 + 验证码配置 + 各 provider `active/configured/disabledReason` + `smtp.configured` |
| PATCH | `/api/admin/security` | 部分更新策略 / 验证码；`secretKey` 空串不修改。写审计 `settings_update`(detail=`security`) |
| POST | `/api/admin/users/:id/confirm` | 管理员手动确认：`pending_* → active`，写审计 `email_confirm`(detail=`manual`)；已 `active` 幂等 200；`banned` 不可借此解封 → 409 `invalid_input` |

**用户端补充**

- `GET /api/me` 响应带 `status` 与 `confirmEmail:{configured,sent,contactEmail}`，供前端渲染「待确认」页。
- `GET /api/admin/users` 每项补 `confirmRequired:boolean`（`pending_email` / `pending_review` 为 true）。

### 用户状态机

```
                注册（配了 SMTP）
   新用户 ───────────────────────▶ pending_email ──确认链接/管理员确认──▶ active
     │                                      │
     └──────── 注册（未配 SMTP）────────▶ pending_review ──管理员确认──▶ active
                                                                    ▲
   任意状态 ──封禁──▶ banned；解封 ──▶ active（banned 不能被邮箱确认解封）
```

- `active`：完整功能。
- `pending_email` / `pending_review`：**可登录、可看列表 / 下载 / 预览 / 删除**；禁止上传（`POST /api/files/upload`、`POST /api/uploads/init`）与建分享（`POST /api/shares`），拦截返回 403 `email_unconfirmed`，`details.status` 为当前状态。
- 邮箱确认令牌：32 字节 base64url，`kind='confirm'`，**24h** 有效，一次性（`usedAt` 置位后不可复用）；落 `email_tokens` 表。

### 错误码

| 状态 | code | 场景 |
|---|---|---|
| 400 | `signup_domain_not_allowed` | 邮箱域名不在白名单内 |
| 400 | `signup_domain_blocked` | 邮箱域名命中黑名单 |
| 400 | `signup_subaddress_forbidden` | 子地址开关开启且本地部分含 `+` |
| 403 | `email_unconfirmed` | 未确认用户尝试上传 / 建分享 |
| 400 | `captcha_failed` | 验证码缺失 / 被站点验票拒绝（`details.reason`） |
| 503 | `integration_not_configured` | 第三方登录 provider 未配置 |
| 502 | `upstream_error` | SMTP 发信上游错误（`details.smtpCode`） |

### SMTP 传输安全判定与明文风险

- `smtp.secure='true'`：直连隐式 TLS（`tls.connect`）。
- `smtp.secure='false'`：明文连接先 EHLO；服务端 EHLO 通告 `STARTTLS` 且端口非 465 时升级 TLS，升级后重发 EHLO；**服务端不支持 STARTTLS（非 220）或端口 465 以外保持明文**。
- **明文风险**：回落明文时账号 / 密码 / 邮件内容在网络上可被嗅探；生产环境请使用支持 TLS 的端口（465 `secure=true`，或 587 STARTTLS），不要在明文链路上传敏感邮箱密码。
- 认证：优先 `AUTH PLAIN`，回落 `AUTH LOGIN`；服务端两者都不支持则报错。

### 第三方登录说明与未验证声明

- QQ 互联不返回邮箱，按约定用 `<openid>@qq.local` 作为本地账号邮箱（非真实投递地址）；该账号在提供商侧已验证 openid，本站直接视为已确认。
- 通用 OIDC / Logto：走 Discovery（`<issuer>/.well-known/openid-configuration`）→ 授权码换 token → userinfo；`id_token` 校验 `iss` / `aud` / `exp` 声明。**JWKS 签名验签本期未实现**（零依赖约束），仅做声明级校验；上线接真实提供商前应补 JWKS 验签。
- **未验证（沙箱限制）**：QQ 互联 / Logto / 通用 OIDC 的真实授权码交换、userinfo 拉取、回调建号链路均未在沙箱联调；`server/services/oauth/*` 仅按各平台文档实现，需接真实应用复测。

### 挂载点（整合 `server/app.js` 时参考，本轮未改 `app.js`）

```js
// 公开 / 自助（与现有 authRouter 同级）
app.use('/api/auth/confirm', authConfirmRouter);
app.use('/api/auth/oauth', authOauthRouter);
// adminApi 守卫内
adminApi.use('/mail', adminMailRouter);
adminApi.use('/security', adminSecurityRouter);
// 注：/api/auth/security-config 挂在现有 authRouter 内，无需单独挂载
```

## §P9-C 积分 / 商店 / 兑换码 / 付费分享

> 本节先于实现落地（C 批开工前的唯一字段口径），后端与前端都以此为准；实现落地后如与代码不符，**改代码对齐本节**，不反向改本节。

### C-1 数据表（SQLite，列名 camelCase，与现有表一致；金额单位=货币最小单位，整数）

```sql
-- 积分流水：余额由本表 SUM(delta) 汇总，不单独建余额列
CREATE TABLE IF NOT EXISTS points_ledger (
  id          TEXT PRIMARY KEY,       -- pl_<16>
  email       TEXT NOT NULL,
  delta       INTEGER NOT NULL,      -- 正=入账，负=出账
  balanceAfter INTEGER,             -- 写入时的汇总值（展示用，不参与计算）
  source      TEXT NOT NULL,         -- purchase | redeem | commission | share_spend | refund | admin_adjust | signup_bonus
  refType     TEXT,                  -- order | redeem_code | share | null
  refId       TEXT,
  note        TEXT,
  createdAt   TEXT NOT NULL
);
-- source 与 refType 组合约束见 C-4「流水来源枚举」

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,     -- pr_<16>
  name         TEXT NOT NULL,
  tag          TEXT,                 -- 「热门」「推荐」等角标
  description  TEXT,
  type         TEXT NOT NULL,        -- storage_pack | group_upgrade
  storageBytes TEXT,                 -- storage_pack 必填，十进制字符串（EB 上限同 §P7-3）
  durationDays INTEGER NOT NULL DEFAULT 0,  -- 0=永久；group_upgrade 必填 >0（会员时长）
  groupId      TEXT,                 -- group_upgrade 必填：目标组
  priceMinor   INTEGER NOT NULL,     -- 现金价（最小单位）
  pointsPrice  INTEGER,              -- 积分价；null=不支持积分购买
  allowPoints  INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,     -- od_<16>
  orderNo      TEXT NOT NULL UNIQUE, -- 对外订单号 R6-<YYYYMMDD>-<6位>，给用户看的
  email        TEXT,                 -- 买家邮箱；匿名现金下单需要（收凭证邮件）
  productId    TEXT,
  shareToken   TEXT,                 -- 付费分享现金下单时填分享 token
  amountMinor  INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'CNY',
  pointsUsed   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,        -- pending | paid | cancelled | refunded
  channel      TEXT NOT NULL,        -- manual | points | cash
  provider     TEXT NOT NULL DEFAULT 'manual',  -- manual | points | cash | stripe(未实现)
  recoverToken TEXT,                 -- 现金订单恢复凭证（32B base64url，只在建单时下发一次）
  providerRef  TEXT,                 -- 支付渠道单号（manual 为空）
  paidAt       TEXT, refundedAt TEXT, cancelledAt TEXT, expiresAt TEXT,
  note         TEXT,
  createdAt    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code         TEXT PRIMARY KEY,     -- 统一大写、去空格；生成时排除易混字符
  type         TEXT NOT NULL,        -- storage | points | group
  storageBytes TEXT,                 -- type=storage
  points       INTEGER,              -- type=points
  durationDays INTEGER,              -- type=group（会员时长，天）
  groupId      TEXT,                 -- type=group 目标组
  batchId      TEXT NOT NULL,        -- 同一次批量生成共享
  maxUses      INTEGER NOT NULL DEFAULT 1,
  usedCount    INTEGER NOT NULL DEFAULT 0,
  boundEmail   TEXT,                 -- 非空则只能该邮箱兑换
  expiresAt    TEXT,                 -- null=永不过期
  status       TEXT NOT NULL DEFAULT 'active',  -- active | disabled | deleted
  createdBy    TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL
);

-- shares 表新增（ALTER TABLE ADD COLUMN，迁移时补列）
-- paidDownload INTEGER NOT NULL DEFAULT 0
-- pricePoints  INTEGER            -- 积分价，>0 才生效
```

### C-2 settings key（全部存 `settings` 表键值文本）

| key | 类型/取值 | 默认 | 说明 |
|---|---|---|---|
| `billing.pointsPerMinorUnit` | 整数字符串 | `1` | 每 1 个货币最小单位兑换多少积分（充值/现金抵扣口径） |
| `billing.commissionPercent` | `1`–`100` | `10` | 付费分享成交后给分享者的佣金比例（积分） |
| `billing.allowAnonymousPurchase` | `'true'`/`'false'` | `'true'` | 未登录是否可现金下单购买分享/商品 |
| `billing.storeNavEnabled` | `'true'`/`'false'` | `'false'` | 用户端边栏是否显示「商店」入口 |
| `billing.overQuotaGraceDays` | 整数天 | `7` | 容量包到期/降级后超额缓冲期，期内不硬拦上传（仅提示） |
| `billing.cronNotifyExpr` | 表达式 | `'0 9 * * *'` | 通知 Cron（支持 `@every 1h` 与标准 5 段 cron） |
| `billing.cronBanExpr` | 表达式 | `'@every 1h'` | 到期降级/封禁检查 Cron |
| `billing.notifyOnExpireDays` | 整数天 | `3` | 会员到期前几天发通知 |

### C-3 接口（`/api/...`，除标注外都需要登录会话）

**用户端**
| 方法/路径 | 说明 |
|---|---|
| `GET /api/store/products` | 已启用商品列表（按 sort,createdAt）；含 `pointsPrice`、`canPayPoints` |
| `GET /api/store/me` | `{ points, groupId, groupName, groupExpiresAt, spaceLimitBytes, storeNavEnabled, allowAnonymousPurchase, commissionPercent }` |
| `POST /api/store/orders` | body `{ productId }` → 建 `channel:'manual'` 订单，返回 `{ orderNo, amountMinor, payInstructions }` |
| `POST /api/store/orders/:orderNo/pay-points` | 用积分买商品：校验积分足够 → 扣分写流水、`status='paid'`、发放权益（容量/换组） |
| `POST /api/store/redeem` | body `{ code }` → 兑换，返回 `{ type, granted }` |
| `GET /api/store/redeem/:code/preview` | 只校验不兑换（展示类型/额度/是否可用）|
| `GET /api/shares/:token/pay-info`（免登录） | `{ paidDownload, pricePoints, requiresPayment, self, alreadyPurchased }` |
| `POST /api/shares/:token/buy-points` | 积分购买分享：扣买家、按 `commissionPercent` 给分享者写 `commission` 流水；**禁止自己买自己** |
| `POST /api/shares/:token/orders`（免登录可用） | body `{ email }` 现金下单：返回 `{ orderNo, recoverToken, contactEmail, mailSent }` |
| `GET /api/orders/:orderNo`（免登录，需 `?recover=<token>`） | 订单状态查询（凭证不对返回 404）|

**管理端**（`/api/admin`，管理员密码会话或 sudo）
| 方法/路径 | 说明 |
|---|---|
| `GET/POST /api/admin/store/products`、`PATCH/DELETE /api/admin/store/products/:id` | 商品 CRUD（DELETE 软删 `enabled=0`）|
| `GET /api/admin/store/orders?status=&channel=&email=` | 订单列表 |
| `POST /api/admin/store/orders/:id/mark-paid` | **manual 渠道**人工标记已支付：发放权益 + 写订单流水（审计 `order_mark_paid`）|
| `POST /api/admin/store/orders/:id/refund` | 退款：`status='refunded'`；积分单按 `-pointsUsed` 回滚并回收权益（容量减回、会员到期回退）|
| `POST /api/admin/store/orders/:id/cancel` | 仅 `pending` 可取消 |
| `GET/POST /api/admin/store/redeem-codes` | 列表 / 批量生成（`{ count, prefix, type, storageBytes?, points?, durationDays?, groupId?, maxUses, expiresAt?, boundEmail? }`）|
| `PATCH /api/admin/store/redeem-codes/:code` | 禁用（`status='disabled'`）|
| `DELETE /api/admin/store/redeem-codes/:code` | 删除（`status='deleted'`，不可再兑换）|
| `GET /api/admin/store/redeem-codes/export.csv` | CSV 导出（`code,type,额度,有效期,次数,状态`）|
| `GET /api/admin/points/ledger?email=&source=&limit=` | 流水查询 |
| `POST /api/admin/points/adjust` | body `{ email, delta, note }` 手工调账（审计 `points_adjust`）|
| `GET/PATCH /api/admin/store/settings` | C-2 的 billing 设置（PATCH 只传部分）|
| `GET /api/admin/store/cron` | 两个 Cron 表达式与最近一次执行时间/结果 |

### C-4 支付抽象

```js
// server/services/payment/index.js
export const PaymentProvider = {
  id: 'manual',
  createOrder({ order }) -> { orderNo, status:'pending', payInstructions, providerRef? }
  verifyCallback({ req })  -> { ok, orderNo, paidAmount } | throw
  refund({ order, amountMinor }) -> { ok, refundedAmount }
};
export function getProvider(id) // 未知/未配置的 provider 返回 { id, implemented:false, ...三个方法一律抛 notConfigured }
```

- 本期只实现 `manual`：建单 → `pending`；管理员 `mark-paid` 才 `paid`；`refund` 由管理员触发。
- `stripe` 等在线渠道有占位实现，**三个方法都返回错误 `payment_not_configured`**（HTTP 501），绝不返回“成功”。
- 任何自动化流程（Cron、重试、回调）**不得**把订单置为 `paid`。

### C-5 权益发放与到期

- `storage_pack`：写 `user_quotas`/等效结构（依现有实现：容量加成记 `storage_grants` 表 `email, bytes, expiresAt, orderId`），`bytes` 用十进制字符串，`expiresAt=null` 表示永久；配额计算 = 组配额 + 未过期加成之和（BigInt）。
- `group_upgrade`：切到 `products.groupId`，记 `groupExpiresAt = now + durationDays`（存 `users.groupExpiresAt` 或 `group_memberships` 表），到期由 Cron 检查：`groupExpiresAt <= now` → 回默认组（`settings.defaultGroupId`）并把 `groupExpiresAt` 清空，写审计 `group_expired`。
- 到期前 `notifyOnExpireDays` 天写通知（站内 `notifications` 表或 audit `expire_notice`，二选一按实现）。

### C-6 错误码（新增，`server/lib/errors.js` 统一注册）

| code | HTTP | 触发 |
|---|---|---|
| `insufficient_points` | 400 | 积分不足（details 带 `required/available`）|
| `points_disabled` | 400 | 商品 `allowPoints=0` 或 `pointsPrice=null` 却用积分支付 |
| `product_disabled` | 400 | 商品 `enabled=0` 或不存在 |
| `order_not_pending` | 409 | 对非 `pending` 订单做 `pay-points`/`mark-paid`/`cancel` |
| `order_already_paid` | 409 | 重复标记已支付 |
| `order_not_found` | 404 | 订单号不存在或凭证不匹配（对外统一 404，不泄露存在性）|
| `redeem_code_invalid` | 400 | 兑换码不存在/已删除 |
| `redeem_code_disabled` | 400 | `status='disabled'` |
| `redeem_code_expired` | 400 | `expiresAt < now` |
| `redeem_code_exhausted` | 400 | `usedCount >= maxUses` |
| `redeem_code_email_mismatch` | 400 | `boundEmail` 与当前用户不符 |
| `redeem_code_already_used` | 409 | `maxUses=1` 且当前用户已用过（details 带 `usedAt`）|
| `share_not_paid` | 402 | 访问未购买的付费分享内容 |
| `self_purchase_forbidden` | 400 | 自己买自己的分享 |
| `anonymous_purchase_disabled` | 400 | `allowAnonymousPurchase=false` 时未登录下单 |
| `payment_not_configured` | 501 | 调用了未实现的 PaymentProvider 方法 |

### C-7 数值口径

- 所有积分/金额/字节运算：积分与金额为 **整数**（SQLite INTEGER，安全上限同 int64）；字节一律十进制字符串 + BigInt（§P7-3 `server/lib/bytes.js`）。
- 余额查询：`SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE email=?`，写流水与发权益必须在**同一事务**里。
- 佣金：`floor(pricePoints * commissionPercent / 100)`，四舍五入不用银行家舍入；佣金为 0 时也写一条 delta=0 的 `commission` 流水（可审计）。

## 管理端文件索引（Blob）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/blobs?limit=&offset=&q=` | 列表：索引号、存储策略、归属邮箱、用户路径、实际文件名、大小、引用数、状态 |
| GET | `/api/admin/blobs/:id/download` | 按索引号直接下载物理对象 |
| POST | `/api/admin/blobs/:id/transfer` | body `{email, path?}`；仅改 nodes.email/path，物理对象不动 |
| DELETE | `/api/admin/blobs/:id?mode=soft\|hard` | soft 软删节点；hard 软删并释放引用（归零标记 orphan） |

物理布局固定为 `<策略根>/uploads/<8位索引>/<原文件名>`；用户改名/移动/跨策略移动都只改 SQLite 元数据。
