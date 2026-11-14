# 验收记录（P0/P1/P2/P3）

> 本文只记“实测到什么”，不写愿景。所有命令可在仓库根直接复现。

## 1. 本轮验收标准与证据

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 全新启动后 `docker compose up` 可起 | **部分验证**：沙箱内无 Docker，无法实跑 `docker compose up`；改为按 Dockerfile 的 COPY 集合在 `.build/appsim/` 复制同一份文件、同版本 Node 全新建依赖后启动，`/`、`/login`、`/admin/login`、`/assets/*`、`/api/setup/status` 全部 200；`docker-compose.yml` 通过 YAML 解析，仅 `drive` 一个活跃 service | 见 §3 与 §4 |
| 2 | 不用 Docker 时 `node server/index.js` 可起 | 通过 | 本机实测启动，端口 8099 |
| 3 | 全新启动登录页为空态，且**只显示一条**最高优先级引导 | 通过 | `docs/screenshots/01-login-empty.png`；脚本断言“可见 `.note` 数量 = 1 且文案含 Supabase” |
| 4 | Supabase 未配置时登录被拒 | 通过 | `POST /api/auth/login` → `412 supabase_not_configured`（脚本断言） |
| 5 | 后台填错 Supabase key 有明确报错且**不落盘脏数据** | 通过 | `POST /api/admin/supabase` 传 `https://nope.supabase.co` → `400 supabase_unreachable`（`reason` 说明连接失败）；随后 `GET /api/admin/supabase` 仍 `configured:false` |
| 6 | 用户 A 看不到用户 B 的文件 | 通过 | bob 读 `alice@x.com/inbox` → `403 forbidden`；`data/volume/` 下按 `<Email>/` 物理隔离 |
| 7 | 路径形如 `data/<Email>/...` | 通过 | `data/volume/alice@x.com/inbox/...`；`GET /api/files` 返回的面包屑首层即 Email |
| 8 | 超空间 / 超单文件 / 超 7 天流量分别给出不同提示 | 通过（接口层） | `413 quota_file`、`409 quota_space`、`429 quota_traffic` 三种错误码与中文 message 各不相同，均带 `details` 数字；前端 `public/files.html` 按 code 分三条不同文案渲染 |
| 9 | 普通用户访问 `/admin/*` 一律 403 | 通过 | 页面 `403` + 中文提示页（`docs/screenshots/09-admin-403.png`）；`/api/admin/**` 返回 `403 forbidden` JSON |
| 10 | 管理后台概览可用 | 通过 | `docs/screenshots/03-admin-home.png`（14 天趋势 Canvas、策略占比环形图、最近操作、待初始化提示条） |
| 11 | 添加存储策略前必须告知“哪些信息会展示给普通用户”，勾选后才能创建 | 通过 | `docs/screenshots/06-admin-storage-disclosure.png`；接口层未带 `acknowledgeDisclosure` → `400 not_acknowledged`，带 `true` → `201` |
| 12 | 除 admin 外至少 2 个用户组才放行 | 通过 | 仅 1 组时 `next:"groups"`；建到 2 组后 `next:"site"`；补全站点信息后 `next:"ready"` |
| 13 | 回收站可软删 / 恢复 | 通过 | 删 → `GET /api/trash` 可见 → `POST /api/trash/restore` 恢复 |
| 14 | 重启后数据仍在 | 通过 | 重启进程后 `users/groups/strategies` 与物理文件均完整 |
| 15 | 路径穿越被拦截 | 通过 | `path=alice@x.com/../bob@x.com` → `403 forbidden` |

## 2. 未验证项（如实说明）

| 项 | 原因 | 上线前怎么补 |
|---|---|---|
| 真实 Supabase 登录、token 校验、refresh 续签、admin users 拉取 | 沙箱内没有可用的 Supabase 实例，`*.supabase.co` 不可达 | 用真实项目跑一次 `/admin/users.html` 的“保存配置 → 连通性自检 → 用邮箱密码登录” |
| `docker build` / `docker compose up` | 沙箱未安装 docker（`docker: command not found`） | 在有 Docker 的机器上 `cp .env.example .env && docker compose up -d --build`，重点看 better-sqlite3 预编译包是否命中当前平台 |
| 浏览器端三种配额提示的逐一截图 | 已跳过演示数据，仅截全新安装状态 | 起一个已配置站点，用 `docs/verify.md` §4 的命令上传超限文件即可复现 |

## 3. 已执行的自检

```bash
# 后端接口（全新库，DEV_AUTH=1 仅为无 Supabase 时的本地会话兜底）
npm ci
PORT=8099 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js &
BASE=http://127.0.0.1:8099 node tools/smoke-test.mjs
# 结果：28/28 通过
```

覆盖：初始化状态机 5 个 `next`、管理员登录（错/对密码）、Supabase 坏配置不落盘、建组、建策略（含披露确认）、登录、建目录、5MB 上传、下载字节数一致、重命名、移动、软删、回收站、恢复、越权 403、路径穿越、三种配额错误码、重启持久化。

```bash
# 页面截图 + 前端断言（全新库，浏览器上下文按角色隔离）
PUPPETEER_DIR=<含 puppeteer-core 的目录> BASE=http://127.0.0.1:8099 ADMIN_PASSWORD=test123 node tools/capture.mjs
# 结果：9 张截图，断言全部通过（无横向溢出、无未捕获 JS 异常）
```

## 4. 截图

| 文件 | 说明 |
|---|---|
| `docs/screenshots/01-login-empty.png` | 全新安装登录页：仅一条 Supabase 引导，登录按钮置灰为“站点尚未就绪” |
| `docs/screenshots/02-admin-login.png` | 管理密码登录页 |
| `docs/screenshots/03-admin-home.png` | 管理概览（空库真实数据 + 待初始化提示） |
| `docs/screenshots/04-admin-users.png` | 用户页：Supabase 配置卡 + 用户列表空态 |
| `docs/screenshots/05-admin-storage.png` | 存储策略页空态 |
| `docs/screenshots/06-admin-storage-disclosure.png` | 添加策略弹窗：展示告知清单，确认框默认不勾选、创建按钮禁用 |
| `docs/screenshots/07-admin-groups.png` | 用户组页（默认组卡片） |
| `docs/screenshots/08-admin-settings.png` | 站点设置：出厂默认值高亮 |
| `docs/screenshots/09-admin-403.png` | 普通用户/匿名访问 `/admin/*` 的 403 页 |

## 5. 已知取舍

- **Docker 未实跑**：交付的是“结构核对 + 等价启动”，不是 `docker build` 成功日志。
- **Supabase 只做了失败路径**：坏配置能明确报错且不写脏数据是实测过的；成功路径需要真实项目。
- **`DEV_AUTH` 是自测开关**：默认 `0`，开启后 `POST /api/auth/dev-login` 可绕过 Supabase（仅用于没有 Supabase 的本地联调），生产必须关闭。
- **预览、WebDAV、离线下载、Office 编辑、PWA/i18n** 只留了接口位与页面骨架，按契约返回 `501 not_implemented` 或 `available:false`，未实现细节（S3/GitHub 策略已在 P2 实现，见 §6）。

## 6. P2「多存储后端」验收

### 6.1 逐项结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 存储策略支持 `s3`（endpoint/region/bucket/AK/SK/pathStyle/prefix）与 `github`（只读 repo/branch/rootPath/token） | 通过 | `GET /api/admin/storage/types` 返回 3 个类型全部 `status:"ready"`；`POST /api/admin/storage` 分别建出 s3/github 策略 201 |
| 2 | S3 真实读写（自研 SigV4，流式，不整文件进内存） | 通过（对本地假 S3） | `node tools/test-s3.mjs` → 9/9；6 MB 与 12 MB 往返、sha256 一致、RSS 不随文件线性增长 |
| 3 | S3 上传/下载/删除/列举/重命名全部走 S3 API | 通过（对本地假 S3） | 同上用例 2–7；另经 HTTP 走完整链路：`POST /api/files/upload` 后对象真实存在于假 S3 的 `p2-prefix/alice@x.com/media/hello.txt` |
| 4 | GitHub 只读列举与下载 | **部分验证** | 带 token 跑 `GITHUB_TOKEN=… node tools/test-github.mjs` → 4/4 PASS（`octocat/Hello-World` 列到 README、流式读到 13 字节、不存在仓库 404 分类正确）；匿名在该沙箱 IP 被 GitHub 限流至 403，脚本按限流标 SKIP |
| 5 | 任何写操作命中只读策略必须 403 `strategy_readonly` | 通过 | `POST /api/files/upload` 到绑定 github 的目录 → `403 strategy_readonly`；`POST /api/files/folder` 同目录 → 同码；message 含“只读”，可直接展示 |
| 6 | 目录绑定解析顺序「最深匹配绑定 > 用户组默认 > 站点默认 > local」 | 通过 | `/api/admin/bindings/resolve` 三例：`alice@x.com/media/a.txt` → `binding`/s3；`alice@x.com/other/x.txt` → `local`/volume；`alice@x.com/archive/x.txt` → `binding`/github |
| 7 | 绑定增删改查，且用户端文件列表能看到当前目录落哪个策略 | 通过 | `POST/GET/PATCH/DELETE /api/admin/bindings`；`GET /api/files?path=alice@x.com/media` 返回 `strategy:{type:'s3',matchedBy:'binding',readOnly:false,bindingPath:'media'}` |
| 8 | 远端列举与本地元数据合并（不重复、远端标 `remote:true`） | 通过 | 直接在假 S3 里放 `remote-only.txt` 后列表同时出现本地 `hello.txt` 与远端条目，`hello.txt` 只出现一次 |
| 9 | 跨策略搬运（s3 → volume） | 通过 | `POST /api/files/move` 200；源对象从假 S3 消失（`key 存在=false`），目标可下载且字节一致 |
| 10 | 密钥只在服务端、接口一律脱敏 `****末四位` | 通过 | 列表 `configMasked.accessKeyId="****MPLE"`；响应体与绑定列表全文 grep 不含明文 SK / AK / `ghp_` |
| 11 | 保存前「测试连接」 | 通过 | `POST /api/admin/storage/validate` 对本地假 S3 → 200 `{ok:true,message:"连接正常，bucket「p2-bucket」可访问"}`；对 capto 不可达端点 → 200 `{ok:false}` 且不 500 |
| 12 | 被绑定引用的策略不可删除 | 通过 | `DELETE /api/admin/storage/:id` → 409，`details.bindingCount` 给出引用数 |
| 13 | P1 功能不回归 | 通过 | `node tools/smoke-test.mjs` → **52/52**（原 28 项全在，P2 新增 24 项） |

### 6.2 未验证 / 沙箱限制（如实说明）

| 项 | 原因 | 上线前怎么补 |
|---|---|---|
| 真实 S3（AWS / MinIO / R2）联调 | 沙箱无外网对象存储，只有本地 `tools/fake-s3.mjs`（内存假 S3，校验签名头存在但不校验签名值） | 用 MinIO 或真实桶跑 `POST /api/admin/storage/validate` 与一次上传下载；重点看非 `/` 分隔符服务与 pathStyle=off 的 DNS 端点 |
| S3 分块上传（Multipart）、STS 临时凭证、presigned URL | 未实现（单次 PUT + `UNSIGNED-PAYLOAD`） | 大文件（>5 GB）场景需要补 multipart |
| S3 列表分页 | 单页 `max-keys=1000` | 单目录超 1000 对象需补 `continuation-token` |
| GitHub 匿名访问 | 沙箱出口 IP 被 GitHub 限流（403 rate limit） | 带 token 已实测；生产建议配 token 提高限额 |
| GitHub 只读策略下的跨策略移动 | 目标目录只读时会先被 403 拦下（这是期望行为） | — |
| virtual-host 形态对 IP 端点 | 无法构造合法子域，`pathStyle=auto` 默认走 path-style | 用 DNS 域名端点时再验 `off` |

### 6.3 已执行的自检命令

```bash
cd /home/user/Doubao/chats/38453631157677314/r6t5-drive
# 全量回归（含 P2 段：假 S3 put/get/list/delete、绑定解析、只读拒绝、跨策略搬运、脱敏）
PORT=8090 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js &
BASE=http://127.0.0.1:8090 node tools/smoke-test.mjs     # 52/52
# S3 驱动（自带假 S3，无需外部依赖）
node tools/test-s3.mjs                                    # 9/9
# GitHub 驱动（不带 token 时限流自动 SKIP，不算通过）
GITHUB_TOKEN=<pat> node tools/test-github.mjs             # 4/4
```

### 6.4 截图

| 文件 | 说明 |
|---|---|
| `docs/screenshots/p2/storage-volume.png` | 文件系统页：本机数据卷策略（类型徽标、健康状态、能力标签） |
| `docs/screenshots/p2/storage-s3.png` | 添加 S3 策略表单（类型切换后字段变化、测试连接按钮） |
| `docs/screenshots/p2/storage-github.png` | GitHub 只读策略（只读标记与说明） |
| `docs/screenshots/p2/storage-bindings.png` | 目录绑定列表（作用域、路径、策略） |
| `docs/screenshots/p2/storage-resolve.png` | 解析调试：输入路径 → 命中策略与 `matchedBy` |
| `docs/screenshots/p2/files-readonly.png` | 文件页在只读目录：上传/新建按钮禁用 + 中文只读提示 |

### 6.5 实现位置（便于后续维护）

- 绑定优先级：`server/services/bindings.js` 的 `resolveStorage()`（先按 `subPath` 深度取最大命中，同深度 `scope='user'` 优先；否则 `groups.defaultStrategyId`；否则 `settings.defaultStorageId`；否则第一个启用的 `volume`）。
- 驱动分发：`server/services/storage/driver.js`（`getDriver(type)` / `driverCaps(type)` / `isWritable(type)`）。
- 只读拦截：`server/routes/files.js` 的 `assertWritable()`，在上传、建目录、重命名、移动、软删前统一调用。
- S3 SigV4：`server/services/storage/s3.js`（SignedHeaders 固定 `host;x-amz-content-sha256;x-amz-date`，`UNSIGNED-PAYLOAD`，`auto/on` 走 path-style）。

## 7. P3「分享与预览」验收

### 7.1 逐项结果（实测）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 分享可设有效期（永久 / 1d / 7d / 30d / 自定义时间） | 通过 | `tools/test-p3-shares.mjs`：`expiresIn=30d` 实测 30.00 天后过期；自定义过去 ISO → `status=expired`；`permanent` → `expiresAt=null` |
| 2 | 提取码可空 / 必填校验 / 明文不落库 | 通过 | 带码分享 `hasCode=true`，错码 403 `share_code_invalid`；`GET /api/shares`、meta、管理端列表全文 grep 不到提取码明文 |
| 3 | 下载次数上限 | 通过 | 额度=2 时第一次/第二次 200，第三次 410 `share_exceeded`；`downloadCount` 递增正确 |
| 4 | 文件与目录都能分享，目录按只读浏览 | 通过 | 目录分享 201 `isDir=true`；`GET /api/share/:token/list` 列出子项；越界路径 403 `forbidden` |
| 5 | 无效 / 过期 / 超次 / 撤销返回对应错误码 | 通过 | 404 `share_not_found`、410 `share_expired`、410 `share_exceeded`、410 `share_revoked`（用户撤销与管理端撤销都实测） |
| 6 | 管理端可列出与撤销分享 | 通过 | `GET /api/admin/shares` 可见；`DELETE /api/admin/shares/:id` 后公开访问立即 410；审计落 `share_create`/`share_revoke` |
| 7 | 图片预览 | 通过 | `GET /api/files/preview` → 200 `image/png`；`exif=1` 时 JPEG 回传 `X-Image-Orientation: 6` |
| 8 | 视频 Range 拖动（206） | 通过（本地卷） | `Range: bytes=0-99` → 206 + `Content-Range: bytes 0-99/5242880`；越界 → 416 `bytes */5242880`；无 Range → 200 全量 |
| 9 | 文本/代码预览限大小、服务端返回原文 | 通过 | `note.txt` → JSON `kind=text`；1,048,592 字节文本 → 413 `preview_too_large`（上限 1 MB） |
| 10 | Markdown 渲染防 XSS | 通过 | 恶意输入含 `<script>`、`onerror=`、`javascript:`、`<iframe>`、`<object>` → 输出命中数全为 0；浏览器侧断言 `window.__xss` 未写入、`.md-body` 内无 `<script>`/`onerror` |
| 11 | PDF 浏览器内嵌 | 通过 | 200 + `application/pdf` + `Content-Disposition: inline` |
| 12 | 不支持的类型不返回 200 空壳 | 通过 | SVG → 415 `preview_unsupported`（理由：内联 SVG 可执行脚本）；未知后缀 → 415 |
| 13 | 未授权 / 未解锁访问被拦 | 通过 | 分享未解锁下载 401 `share_code_required`；登录预览无策略 412 `storage_not_configured` |
| 14 | P1/P2 不回归 | 通过 | `node tools/smoke-test.mjs` 52/52 |

### 7.2 未验证 / 沙箱限制（如实说明）

| 项 | 原因 | 上线前怎么补 |
|---|---|---|
| 真实视频解码播放 / 浏览器实际发起的 Range 请求 | 前端种子 mp4 是 28 字节占位桩，`<video>` 已挂载但未真解码 | 上传一个真实 mp4，用 Chrome 拖动进度条并看 206 响应 |
| PDF 页面内实际渲染 | 种子 PDF 为最小桩文件 | 上传真实 PDF，检查 iframe 渲染与打印 |
| EXIF 方向 2–8 的前端旋转效果 | 只造了 Orientation=6 的样本，前端 `rotate()` 映射未逐值核对 | 用 8 张不同 orientation 的照片逐一看 |
| 提取码连错 5 次锁定 15 分钟 | 服务层逻辑与单测覆盖；未等真实 15 分钟窗口 | 手动连错 6 次观察 403 与解禁 |
| 远端策略（S3/GitHub）上的视频 Range | 本机只有 volume 与 fake-s3（fake-s3 不回 206） | 接真实 S3/MinIO 后拖进度条验证 |
| GitHub 远端 >100MB 预览的临时落盘分支 | 无在线大文件样本 | 用大文件仓库验证 415 文案 |
| 浅色主题逐页核对 | 截图在默认深色主题完成，样式全部走既有令牌 | 切浅色主题再看 9 张页面 |
| Docker 内运行 | 沙箱无 docker | 同 P1 说明 |

### 7.3 已执行的自检命令

```bash
cd /home/user/Doubao/chats/38453631157677314/r6t5-drive
PORT=8090 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js &
BASE=http://127.0.0.1:8090 node tools/smoke-test.mjs            # 52/52
BASE=http://127.0.0.1:8090 node tools/test-p3-shares.mjs        # 50/50（HTTP + service 两层）
PREVIEW_BASE=http://127.0.0.1:8090 node tools/test-p3-preview.mjs # 14/14（脚本自建 fixture）
```

### 7.4 截图（`docs/screenshots/p3/`）

| 文件 | 说明 |
|---|---|
| `share-locked.png` | 带提取码的分享锁定态 |
| `share-file.png` | 单文件分享（下载 + 预览） |
| `share-dir.png` | 目录分享（面包屑 + 列表） |
| `share-expired.png` | 过期分享的中文错误页 |
| `files-share-dialog.png` | 文件页创建分享弹窗（有效期/提取码/次数/允许预览） |
| `files-preview-image.png` | 图片预览弹层 |
| `files-preview-markdown.png` | Markdown 预览（净化后渲染） |
| `files-my-shares.png` | 「我的分享」抽屉 |
| `admin-shares.png` | 管理端分享列表与筛选 |

### 7.5 实现位置

- 分享业务与提取码派生：`server/services/shares.js`（PBKDF2-sha512、10 万次、salt 16B；连错限流 `FAIL_MAX=5`/`FAIL_WINDOW_MS=15min`）。
- 分享路由：`server/routes/shares.js`（`userRouter` 与 `publicRouter` 分离），管理端 `server/routes/admin-shares.js`；挂载见 `server/app.js`（`/api/shares` 套 `requireUser`，`/api/share` 免登录）。
- 预览统一入口：`server/services/preview.js` 的 `sendPreview({req,res,strategy,logicalPath,node})`；类型分类 `classify()`；JPEG EXIF `jpegOrientation()`。
- Markdown 净化：`server/lib/markdown.js`（先整段转义 → 白名单语法 → 链接协议白名单 → 输出后 `assertSafeHtml()` 复检）。
- Range：volume 用 `fs.createReadStream({start,end})`；S3 用 `Range` 请求头（`caps.range=true`）；GitHub `caps.range=false`，≤100MB 落临时文件按范围读，>100MB 返回 415。
