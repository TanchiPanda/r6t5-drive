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

## 8. P4「传输增强」验收（后端）

### 8.1 逐项结果（实测）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 分片上传三段接口（init / part / complete） | 通过 | `BASE=http://127.0.0.1:8090 node tools/test-p4-uploads.mjs` → **28/28**；3 片（1MB+1MB+0.5MB）合并后下载 sha256 一致 |
| 2 | 断点续传（服务端记录已完成分片） | 通过 | 只传 1 片时 `GET /api/uploads/:id` 返回 `missing=[1,2]`；只补缺片即可 complete；乱序 + 重复上传同 index 仍去重为 `[0,1,2]` |
| 3 | 缺片 complete 被拒 | 通过 | 409 `upload_incomplete` + `details.missing=[1,2]` |
| 4 | 分片落临时目录、完成合并后清理 | 通过 | `<STORAGE_ROOT>/.tmp/chunks/<id>/`；abort 后目录不存在，重复 abort 幂等 |
| 5 | 过期分片清理 | 通过 | 会话 24h 过期；`server/index.js` 启动扫一次 + 每小时 `sweepExpired()`（启动日志 `[uploads] 过期会话扫描完成`）；过期会话传片 410 `upload_session_expired` |
| 6 | 并发 | 通过（代码 + 单请求验证） | 同一会话 complete 用内存锁串行化，第二次返回 409；part 先写 `.tmp` 再原子 rename |
| 7 | 批量打包下载（流式，不落整包） | 通过 | `tools/test-p4-archive.mjs` → **39/39**；10MB 文件打包 RSS 增量 0–0.9MB；`unzip -t` `No errors detected` |
| 8 | 打包文件名 UTF-8 | 通过 | `Content-Disposition: attachment; filename*=UTF-8''...`；反向互通测试：系统 `zip` 造的中文名包能被自研 reader 正确读回 |
| 9 | 在线压缩 | 通过 | `POST /api/files/compress` 201，产物 `unzip -t` 通过、回读 sha256 一致 |
| 10 | 解压（含大小/条目上限） | 通过 | `POST /api/files/extract` 201 `extracted=3`；重复解压全部 `skipped(exists)` 不覆盖 |
| 11 | zip slip 防护 | 通过 | 含 `../evil.txt`、`/abs/evil.txt`、`a/../../evil.txt`、反斜杠、符号链接 → 400 `zip_slip_blocked`，目标目录无任何新文件 |
| 12 | 只读策略拦截 | 通过 | 只读目录压缩/解压 → 403 `strategy_readonly` |
| 13 | 非法 zip | 通过 | 截断包 / 非 zip → 400 `zip_invalid`（"未找到 ZIP 中央目录结束记录"） |
| 14 | P1–P3 不回归 | 通过 | `node tools/smoke-test.mjs` → **55/55**（新增「软删后同名重建」回归项） |

### 8.2 顺带修掉的一个真实缺陷

`nodes.path` 原本是内联 `UNIQUE`，软删（回收站）留下的 tombstone 会继续占用路径，导致**同名文件重新上传/解压/压缩直接 500 `UNIQUE constraint failed`**。

- 修法：`server/schema.sql` 改为「仅未删除行唯一」的部分唯一索引 `idx_nodes_path_active`；`server/db.js` 的 `migrate()` 检测到老库内联 UNIQUE（自动索引作用在 `path` 上）时自动重建 `nodes` 表并迁移数据（已用构造老库实测：2 行数据无损、同名重建成功、活跃路径重复仍被拦）。
- 回归项：`tools/smoke-test.mjs` 的 22a/22b/22c（上传 → 软删 → 同名重建 201）。
- `restoreRecursive` 现在会在「目标路径已被活跃节点占用」时返回 409 `conflict`，而不是抛 SQLite 约束错误。

### 8.3 未验证 / 沙箱限制

| 项 | 原因 | 上线前怎么补 |
|---|---|---|
| 前端多选 / 分片进度 / 续传 UI / P4 截图 | **本期未完成**（前端产线未交付） | 需要单独一轮前端实现与截图 |
| S3/GitHub 策略上的分片上传与打包解压 | 本机只有 volume 与 fake-s3（fake-s3 不回 206） | 接真实 S3 后复跑 |
| 10001 条目 / 5GB 上限的 HTTP 级用例 | 造 1 万节点太慢，改为 lib 级单测覆盖 | 需要时用脚本批量造节点 |
| ZIP64（>4GiB） | 不支持，按上限拒绝 | 超大包需求需补 ZIP64 |
| RSS 精确隔离测量 | 服务端与测试同机，6MB 用例受 V8 堆抖动影响（已为断言设 32MB 上限）；另用 100MB 分片上传实测 RSS 增长 9MB | 需要时用独立进程 + 采样器 |

## 9. P5「扩展能力」验收（截至本轮）

### 9.1 已完成并实测

| # | 能力 | 结果 | 证据 |
|---|---|---|---|
| 1 | WebDAV 最小可用集（OPTIONS/PROPFIND/GET/HEAD/PUT/DELETE/MKCOL/MOVE） | 通过（临时挂载实例） | `tools/test-p5-dav.mjs` → **42/42**；PUT 2MB 落盘、MOVE（绝对 URL Destination）、Overwrite=F 412、只读 403、未支持方法 405 且 Allow 正确、PROPFIND XML 不含 Email 段 |
| 2 | 应用密码（Basic Auth 凭据） | 通过 | 创建时只返回一次明文；列表仅 `id/name/createdAt/lastUsedAt/revokedAt`；撤销后 401；库内仅 PBKDF2 hash + salt |
| 3 | 离线下载（aria2 可选集成） | 通过（对本地假 aria2） | `tools/test-p5-integrations.mjs` → **28/28**；未配置 → 503 `integration_not_configured`；配置但不可达 → 502 `upstream_error`；可用 → 201 建任务并透传 `tellStatus` |
| 4 | Office 在线编辑（OnlyOffice 可选集成） | 通过（只读预览模式） | 未配置 → 200 `enabled:false` + 中文 reason；配齐 `OO_DS_URL`+`OO_JWT_SECRET` → `enabled:true`、三段式 JWT 验签通过、docx/xlsx/pptx 分别 word/cell/slide；回调如实返回 `error:1`「P5 未实现保存回写」 |
| 5 | 密钥不外泄 | 通过 | 响应/日志 grep 不到 `ARIA2_SECRET`、`OO_JWT_SECRET` 明文 |
| 6 | P1–P4 不回归 | 通过 | 挂载全部新路由后 `smoke-test.mjs` **55/55** |

### 9.2 未完成 / 未验证（如实说明）

| 项 | 状态 | 原因 |
|---|---|---|
| 媒体元数据（图片尺寸 / 音视频时长） | 代码在写，**未验收** | 产线未回结果，本期不宣称可用 |
| PWA + i18n（zh-CN/en-US、离线壳） | **未开始** | 时间用尽，未实现 |
| WebDAV 在正式 `app.js` 挂载后的回归 | 未跑 | 仅在脚本自建临时 express 实例上 42/42；正式挂载已加（`/dav` 在 `express.json` 之前），需再跑一次 `tools/test-p5-dav.mjs` 确认 |
| 真实 aria2 / 真实 OnlyOffice Document Server | 未验证 | 沙箱无法启动这两个外部服务，只对本地假 aria2 与 JWT 自校验 |
| WebDAV 跨策略 MOVE、Range | 未验证 / 未实现 | 跨策略依赖远端驱动；Range 未实现（未写 `Accept-Ranges`，不声称 206） |

## 10. 控制台：账号来源切换与本地账号（实测）

### 10.1 逐项结果（实测）

| # | 接口 / 能力 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | `GET /api/admin/user-source` | 管理员登录后读取；断言 `userSource`（缺省 `supabase`）、`default`、`storage.table=settings`、`storage.key=userSource`、`counts.total/localAccounts`、`switchedAt` 字段齐全 | 通过（`test-p6-user-source.mjs` 1b/1c；smoke 56h2） |
| 2 | `PUT /api/admin/user-source`（`{source, confirm:true}`） | 切 `volume` → 200 `{ok:true, switchedFrom, switchedTo, changedAt}`；缺 `confirm` → 400 `invalid_input`（`details.field=confirm`）；`source` 非法 → 400（`details.field=source`）；收尾切回 `supabase` | 通过（P6 2a/2b/2c、7d、7h；smoke 56a1、56h1） |
| 3 | `GET /api/setup/status` 的 `userSource` 字段 | volume 模式下断言 `next !== 'supabase'`、`userSource='volume'`、`checks.supabase=true`、`checks.supabaseRequired=false`，hint 不含 Supabase 字样 | 通过（P6 2d/2e；smoke 56a2） |
| 4 | `POST /api/admin/users`（volume 本地建号） | body `{email, password, displayName?}` → 201 `item.source='local'`、`status='active'`、`registeredAt` 有值；email 唯一；密码 scrypt 落 `users.passwordHash`；审计 `user_create` | 通过（P6 3a；smoke 56b1） |
| 5 | `POST /api/auth/login`（volume 本地校验） | 密码正确 → 200，会话 `local:true`、`accessToken/refreshToken=null`、7 天有效；`/api/me` 200；`lastLoginAt` 更新 | 通过（P6 3b/3c；smoke 56b2/56b3） |
| 6 | `POST /api/admin/users/:id/password` | volume 模式改密 200，旧密码 401、新密码 200，审计 `user_password`；supabase 模式 → 409 `not_supported_in_source`（提示去 Supabase 侧改） | 通过（P6 7a/7b/7c/7e） |
| 7 | `PATCH /api/admin/users/:id`（`status:active|banned`） | 封禁 → 200 `status='banned'` 且 `disabled` 同步为 true，审计 `user_ban`；解封 → `status='active'`，审计 `user_unban`；兼容老字段 `disabled` | 通过（P6 5b/6a；smoke 56d1、56e1） |
| 8 | `DELETE /api/admin/users/:id?deleteFiles=0` | 仅删 `users` 行 + 附属记录（shares/share_hits/app_passwords/upload_sessions/traffic/用户级 binding），保留文件节点与对象；删号后既有 cookie `/api/me` 401/403（不 500）；审计 `user_delete`（`files:kept`） | 通过（P6 8c1/8c2；smoke 56g1/56g2） |
| 9 | `DELETE /api/admin/users/:id?deleteFiles=1` | 清空该 email 全部 nodes（含回收站）→ 经现有存储驱动删物理对象与用户目录；返回 `{deletedFiles:{nodes,bytes}}`；他人文件仍可下载、不受影响；审计 `user_delete`（`files:deleted`） | 通过（P6 8d1/8d2/8e） |
| 10 | Supabase 映射行删号（无 `passwordHash`） | 只删本地记录，响应 `supabaseUserKept:true` + 「Supabase 中的用户未被删除」；审计 detail 带 `supabase:kept` | 通过（手工构造无 hash 行实测，见 §10.5） |
| 11 | 列表字段（抽屉消费） | `GET /api/admin/users` 每项含 `status`、`registeredAt`、`source`（`local`/`supabase`）、`lastLoginAt`（空值 `null`）；登录后 `registeredAt`/`lastLoginAt` 均为非空时间字符串 | 通过（P6 5a/9；smoke 56f） |
| 12 | P1–P5 不回归 | 全新隔离库跑 `tools/smoke-test.mjs` | 通过，**72/72**（原 55 项 + 本段并入的 17 项 56x 系列）；独立脚本 `tools/test-p6-user-source.mjs` **39/39** |

### 10.2 存储位置

- 账号来源存在 SQLite **`settings` 表，key `userSource`**，取值 `"supabase"` | `"volume"`；缺省（无该行）= `"supabase"`，保持现网行为。切换时间存同表 key **`userSourceChangedAt`**。
- 读写统一封装在 `server/services/user-source.js`（`getUserSource()` / `setUserSource(src)` / `isVolumeSource()` / `getSwitchedAt()` / `setSwitchedAt(iso)`），其它模块不散落写 SQL。
- 本地密码 scrypt：格式 `scrypt$N$r$p$saltB64$hashB64`，salt 16B、hash 64B，`N=16384 r=8 p=1`。

### 10.3 封禁让 session 立即失效的机制

- `server/middleware/auth.js` 的 `resolveUser()` **每次请求都查库**取用户行，校验 `status === 'banned' || disabled === 1`，命中即 403 `account_banned`；不依赖会话过期。因此写上传、下载、分享、目录浏览等**所有走 `requireUser` 的路径**在封禁后下一次请求即被拦。
- 会话带 `local:true`（或当前 `userSource==='volume'`）时跳过 Supabase access token 校验；用户行不存在仍 401 `unauthorized`。
- WebDAV 不走 `requireUser`，在 `server/routes/dav.js` 的 `basicAuth()` 里**另外按 `status`/`disabled` 判封禁**，命中 403。
- 封禁/解封同时写 `users.status` 与老列 `disabled`（两列同步，读取以 `status` 为准）。

### 10.4 删号两选项行为差异

| 选项 | 删了什么 | 保留什么 | 响应 |
|---|---|---|---|
| `deleteFiles=0` | `users` 行 + 附属记录（shares、share_hits、app_passwords、upload_sessions、traffic、用户级 storage binding） | 文件节点（`nodes` 行）与存储物理对象/目录 | `deletedFiles.nodes=0, bytes=0`；审计 `files:kept` |
| `deleteFiles=1` | 上述全部 + 该 email 名下所有 nodes（含回收站）+ 经存储驱动删除的物理对象与用户目录 | 无（该账号文件清空） | `deletedFiles.{nodes,bytes}`；审计 `files:deleted` |

- 无 `passwordHash` 的 Supabase 账号：**只删本地记录**，远端 Supabase 用户保留，响应 `supabaseUserKept:true`，message 说明「Supabase 中的用户未被删除」；审计 detail 带 `supabase:kept`。
- 删号后 `users` 行消失，`resolveUser` 下次请求 401（被封禁则 403），实测不出现 500。

### 10.5 凭证错误统一文案（安全设计）

- volume 模式下「账号不存在」与「密码错误」对外**完全一致**：同一 HTTP 401、同一 code `invalid_credentials`、同一 message「邮箱或密码错误」，响应体逐字节相同，不通过 code/message/details 暴露账号是否存在。
- 内部分流只体现在服务端日志与审计 detail：`local_no_user`（无此邮箱）/ `local_bad_password`（密码不符）；被封禁单独走 403 `account_banned`。
- 沿用现有「IP+邮箱 5 次 / 10 分钟」内存限流，本地登录同样计数。

### 10.6 未验证 / 沙箱限制（如实说明）

| 项 | 原因 | 上线前怎么补 |
|---|---|---|
| 真实 Supabase 密码登录、access/refresh token 校验与续签、admin 建号、改密、远端用户保留 | 沙箱内无可用 Supabase 实例，`*.supabase.co` 不可达；supabase 分支只验证了「未配置时的行为」（412 保留、volume 跳过、409 分流） | 接真实 Supabase 项目跑一遍登录、后台建号、改密、删号后核对远端用户是否仍在 |
| S3 / GitHub 绑定目录下删号清远端对象 | 本机只有 volume 与本地 `tools/fake-s3.mjs`；跨策略删对象复用现有驱动 `remove()`，未在真实 S3/MinIO 上验证目录级清理 | 接真实 S3 后对绑定目录下的用户删号，核对远端对象与前缀被清 |
| 真实 scrypt 性能 / 跨版本会话兼容 | 仅在本机 Node 22 实测哈希与校验通过 | 生产压测下确认 scrypt `N=16384` 的登录耗时可接受 |


## 11. P7：自助注册 / sudo / 空间单位 / 版本发布（实测）

### 11.1 逐项结果（实测）

| # | 接口 / 能力 | 规则 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | `POST /api/auth/signup`（volume 自助注册） | body `{email, password, passwordConfirm}`；参数校验：邮箱沿用 `EMAIL_RE`、密码 ≥ 8 位、两次一致；通过校验后在分配组下建本地号（scrypt、`status=active`、`registeredAt=now`），直接建会话，201 `{ok, user, setup:{next:'ready'}}` | 通过 | P7 1d/1e/2a/2b；smoke 57d1/57d2/57e |
| 2 | 注册分配组规则 | `SELECT * FROM groups WHERE allow_self_signup = 1 ORDER BY createdAt ASC, id ASC LIMIT 1`：开启自助注册的组中按 `createdAt` 最早（`id` 兜底）分配；先建的组优先，关闭后落到下一个 | 通过 | P7 1d（落先建的 A）、1f（A 关闭后落 B） |
| 3 | 注册错误码与统一文案 | 无开放组 → 403 `signup_closed`「当前未开放自助注册」；邮箱已存在（含重名封禁）→ 400 `invalid_signup`「注册信息无效」，响应不出现 duplicate/exists/已存在/已注册，内部仅审计 `signup`(detail `signup_duplicate`) | 通过 | P7 1g、2c；smoke 57f、57g |
| 4 | `GET /api/auth/signup-config` | `{available, minPasswordLength:8, source:'volume'|'supabase', reason:'ok'|'closed'|'admin_disabled'}`；volume 无开放组 → `available:false, reason:'closed'` | 通过 | P7 0b/1c/1h；smoke 57c |
| 5 | 同 IP 注册令牌桶 | 容量 **5**，每分钟补 **1** 个；按 `req.ip \|\| req.socket.remoteAddress`；**参数非法（格式/长度/两次不一致）不计数**，通过参数校验的尝试（含邮箱已存在、注册关闭）都计数；超限 429 `rate_limited`「注册尝试过多，请稍后再试」 | 通过 | P7 3/3b；smoke 段内计数未触顶 |
| 6 | sudo 用户组判定 | 位置：`server/middleware/auth.js` `resolveAdminAccess()`。顺序：管理密码会话有效 → `via='password'`；否则读 user 会话查库取 user/group，`group.is_sudo === 1` 且未封禁 → `via='sudo'`（`req.sudoUser={email,groupId,groupName}`）；否则普通用户 403、未登录 401。**每次请求都查库**，改 `is_sudo` 后下一请求即生效 | 通过 | P7 4a–4g；smoke 57h0/57h1/57h2/57i1/57i2 |
| 7 | `GET /api/admin/session`（sudo） | 密码会话返回老结构 + `via:'password'`；sudo 会话返回 `{ok, admin:{via:'sudo', email, groupId, groupName}}`；都不是 → 401 | 通过 | P7 4d；smoke 57h2 |
| 8 | 空间单位换算 | `server/lib/bytes.js`，`UNITS=[B,KB,MB,GB,TB,PB,EB]` 全 1024 进制；`parseSizeToBytes(value,unit)` 十进制字符串精确换算（允许小数），不先 `Number()` 再乘；`formatSize` 人类可读；`toByteString` 十进制字符串供 JSON | 通过 | P7 5a/5b/5c/5d；smoke 57j1 |
| 9 | SQLite INTEGER 上限 | `MAX_SQLITE_INT=9223372036854775807`（约 8 EB）；超限抛 400 `invalid_input`「超出 SQLite INTEGER 上限（约 8 EB）」，`details {field, max:'9223372036854775807'}`；不截断、不改 REAL。实测 1 EB=`1152921504606846976`，1.5 TB=`1649267441664`，0.5 MB=`524288`，200 MB=`209715200`，16 EB(=2^64) 被拒 | 通过 | P7 5a–5f；smoke 57k |
| 10 | 限额入参/出参契约 | 入参两种写法：`spaceLimitBytes/maxFileSizeBytes/traffic7dLimitBytes`（数字或十进制字符串）或 `spaceLimit/maxFileSize/traffic7dLimit:{value,unit}`；出参 `*Bytes` 为十进制字符串，另附 `*Text` 人类可读；配额比较统一 BigInt（`BigInt(size) > limit`），无残留 MB 常量比较 | 通过 | P7 5f/6a/6b；smoke 57j1 |
| 11 | `GET /api/admin/update-status` | 管理员会话；200 且非 5xx；`current.version` 非空字符串。`checked:true` 时再断言 `latest.upgradeCommand` 非空、`hasUpdate` 为布尔；`checked:false`（离线/远端 404/JSON 非法/超时）为降级，不报错。沙箱实测 `checked:false, reason:http_404, version=20261115a` | 通过（降级路径） | smoke 57l |
| 12 | P1–P6 不回归 | 全新隔离库跑回归脚本 | 通过 | 见 11.3 |

### 11.2 关键实现位置

- 注册分配组 SQL：`server/routes/auth.js` `pickSignupGroup()`。
- 令牌桶：`server/routes/auth.js`（容量 5 / 每分钟补 1，进程内存态，Map 按 IP 计数）。
- sudo 判定：`server/middleware/auth.js` `resolveAdminAccess()`；`requireAdminApi` / `requireAdminPage` 复用同一判定。
- 单位换算：`server/lib/bytes.js`（`parseSizeToBytes` / `assertMaxSqliteInt` / `formatSize` / `toByteString` / `MAX_SQLITE_INT`）。
- 限额 BigInt 比较：`server/services/quota.js`（`quotaForUser` + `quotaBig`）、`server/routes/files.js`、`server/services/chunks.js`、`server/services/archive.js`、`server/routes/dav.js`。
- 错误码：`server/lib/errors.js` — `signup_closed`(403)、`invalid_signup`(400)、`rate_limited`(429)；审计白名单补 `signup`、`group_update`（`server/services/audit.js`）。

### 11.3 已执行的自检命令与汇总

隔离环境：`DB_PATH=<db> STORAGE_ROOT=<vol> PORT=<port> DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js`，脚本带 `BASE` 指向实例。

| 脚本 | 汇总（干净隔离库，FAIL=0） |
|---|---|
| `tools/test-p7-signup-sudo-units.mjs` | **35/35 通过** |
| `tools/smoke-test.mjs`（并入 57x 共 18 项） | **90/90 通过**（原 72 + P7 段 18） |
| `tools/test-p6-user-source.mjs` | **39/39 通过** |
| `tools/test-p4-uploads.mjs` | **PASS=28 FAIL=0 总计=28** |
| `tools/test-p4-archive.mjs` | **PASS=39 FAIL=0 总计=39** |

> 回归脚本须在干净库上跑；同一库二次复跑会因残留节点/会话出现 409/404，属测试隔离问题，非服务端回归。

### 11.4 未验证 / 沙箱限制（如实说明）

| 项 | 原因 | 上线前怎么补 |
|---|---|---|
| 真实 Supabase 注册 / 登录 / token 续签 | 沙箱无可用 Supabase 实例，`*.supabase.co` 不可达；supabase 分支保持现有行为，仅 volume 路径端到端验证 | 接真实 Supabase 项目跑一遍注册、登录、建号、改密、删号链路 |
| 分布式注册限流 | 令牌桶为单进程内存 Map，不跨实例/不共享；多副本部署下各实例独立计数 | 接 Redis 等共享存储做跨实例令牌桶 |
| 真实 `docker compose` 升级 | 未在本机执行 `docker compose pull && docker compose up -d`；升级命令来自 `latest.json.upgradeCommand` | 推送 `latest.json` 到远端后，在目标环境实跑升级并核对版本号切换 |
| 远端 `latest.json` 可拉取 | 沙箱内 `raw.githubusercontent.com/.../main/latest.json` 返回 404（`checked:false, reason:http_404`）；需推送后远端才可拉，`checked:true` 分支（`latest.upgradeCommand`、`hasUpdate` 比较）未在沙箱命中 | 推送 `latest.json` 后复测 `checked:true` 路径 |
