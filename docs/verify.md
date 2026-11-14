# 验收记录（P0/P1）

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
- **分享、S3/GitHub 策略、预览、WebDAV、离线下载、Office 编辑、PWA/i18n** 只留了接口位与页面骨架，按契约返回 `501 not_implemented` 或 `available:false`，未实现细节。
