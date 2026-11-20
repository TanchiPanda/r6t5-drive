# R6T5 Drive

Docker 自托管的轻量网盘：**一个容器跑一个站点，容器内提供多用户空间**。后端 Node.js + Express + SQLite，前端纯 HTML/CSS/JS（无构建步骤），文件元数据存本地 SQLite，物理存储可在本地数据卷、S3 兼容对象存储、只读 GitHub 仓库之间选择。


![docker](https://github.com/TanchiPanda/r6t5-drive/actions/workflows/docker.yml/badge.svg)


- 仓库：https://github.com/TanchiPanda/r6t5-drive
- 接口契约：[`docs/api-contract.md`](docs/api-contract.md)
- 部署说明：[`docs/deploy.md`](docs/deploy.md)
- 实施计划：[`docs/plan.md`](docs/plan.md)

## 架构概览

```
                         浏览器
                           │  HTTP
                           ▼
                ┌────────────────────────┐
                │  Node.js + Express 容器 │
                │  server/index.js 入口   │
                ├────────────────────────┤
                │  /api/*  接口路由       │
                │  public/  静态页面与资源 │
                ├──────────────┬─────────┤
                │  SQLite 元数据 │ 文件存储层 │
                │ data/r6t5.db │ 三类策略   │
                └──────────────┴─────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                    ▼
  本地数据卷 volume   S3 兼容存储 s3        GitHub 仓库只读 github
  data/volume/<Email>/ 七牛/OSS/COS/OBS/KS3/…  适配器预留（P2）

账号：Supabase Auth（管理员在后台填 URL / anon key / service key；
     service key 只存服务端，永不下发前端）。
```

## 目录结构

```
r6t5-drive/
├── index.html              介绍页（站点首页）
├── Dockerfile              生产镜像定义
├── docker-compose.yml      编排（含可选侧车注释开关）
├── .env.example            环境变量样例
├── package.json            后端依赖清单
├── server/                 后端入口与路由（Express）
│   ├── index.js            进程入口：迁移 + 启动 + 打印首次管理密码
│   ├── app.js              Express 装配
│   ├── config.js           环境变量与站点设置读写
│   ├── db.js               better-sqlite3 连接与迁移
│   ├── schema.sql          DDL
│   ├── lib/                错误、路径、会话、格式化等基础库
│   ├── middleware/         鉴权中间件
│   ├── routes/             /api 各业务路由
│   └── services/           Supabase、配额、流量、审计、节点、存储适配器
├── public/                 前端静态页与资源（无构建）
│   ├── *.html              登录、文件、账户、分享、管理后台页面骨架
│   └── assets/             样式与前端脚本
├── tools/                  开发期工具（如契约假后端 mock-api.js）
├── docs/                   文档：API 契约、部署说明、实施计划
└── data/                   运行期数据（不入库，见 .gitignore）
    ├── r6t5.db             SQLite 元数据库
    └── volume/             本地卷存储根目录
```

## 快速开始

### 方式一：Docker（推荐）

```bash
cp .env.example .env
# 编辑 .env：至少生成并填入 SESSION_SECRET（openssl rand -hex 32）
docker compose up -d
```

启动后访问 `http://<主机>:5212`。Windows 下用 PowerShell 而不是 `$(...)`：

```powershell
New-Item -ItemType Directory -Force -Path .\data | Out-Null
docker run -d --name r6t5-drive -p 5212:5212 -v "${PWD}\data:/app/data" ghcr.io/tanchipanda/r6t5-drive:latest
```

容器数据落在 `./data` 目录，升级与备份见 [`docs/deploy.md`](docs/deploy.md)。

### 方式二：本机直接运行（不用 Docker）

```bash
npm install
npm start          # 等价于 node server/index.js
```

> 前置条件：Node.js ≥ 20。`better-sqlite3` 在 glibc 环境使用预编译包；若需从源码编译，需准备 `python3`、`make`、`g++`。

## 首次启动五步引导

登录页只读取 `/api/setup/status`，**只向当前最高优先级的一项**给出提示，按顺序完成：

| 步骤 | 状态项 | 要做的事 |
|---|---|---|
| 1 | `supabase` | 管理员凭管理密码进入后台，配置 Supabase URL / anon key / service key 并通过自检 |
| 2 | `storage` | 添加一条可用的存储策略（本地卷 / S3 兼容 / GitHub 只读） |
| 3 | `groups` | 创建除默认组外至少 1 个用户组（共满 2 个可用组），配置空间 / 单文件 / 7 天流量上限 |
| 4 | `site` | 补全站点名、对外地址、默认用户组 |
| 5 | `ready` | 全部通过，普通用户即可用邮箱登录 |

首次管理密码：`.env` 中 `ADMIN_PASSWORD` 留空时，首次启动自动生成并打印到服务端日志；填写则以环境变量为准。

## 用户目录约定

每个用户的物理与逻辑路径都以 **Email** 明示，路径首段必须是本人邮箱，越权访问返回 403：

- 逻辑路径：`alice@example.com/inbox/report.pdf`
- 物理路径：`<STORAGE_ROOT>/alice@example.com/inbox/report.pdf`（默认 `data/volume/alice@example.com/inbox/report.pdf`）

目录分隔符固定 `/`，禁止 `..`、空段与绝对路径穿越。

## 存储策略

| 类型 | 能力 | 状态 | 说明 |
|---|---|---|---|
| 本地数据卷 `volume` | 读写 | P1 已实现 | 直接读写容器挂载的数据目录 |
| S3 兼容 `s3` | 读写 | P2 已实现 | 自研 SigV4（不引 SDK），流式上传下载；支持自定义 endpoint / region / bucket / pathStyle / prefix，兼容 MinIO、R2、OSS、COS、OBS 等 |
| GitHub 仓库 `github` | 只读 | P2 已实现 | Contents API 列目录 + raw 流式下载；写操作一律 `403 strategy_readonly` |

**目录绑定**（P2）：管理员可把某个目录（站点级或指定用户）绑定到任一策略，解析顺序为「最深匹配的绑定 → 用户组默认策略 → 站点默认策略 → 本地卷」。文件页会显示当前目录落在哪个策略上；只读策略下上传、改名、移动、删除都会被拦成 `403 strategy_readonly`。

**创建前披露**：添加策略前，后台会明确告知哪些字段会展示给普通用户——策略名、存储类型、位置/区域、容量、是否只读；密钥、端点、凭证等字段只保存在服务端，任何接口都不下发明文。创建时需勾选披露确认，否则后端返回 `not_acknowledged`。

## API 摘要

完整字段、错误码与状态机以 [`docs/api-contract.md`](docs/api-contract.md) 为准。

| 分组 | 代表接口 | 说明 |
|---|---|---|
| 身份鉴权 | `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/me` | Supabase 校验后写 httpOnly 会话 Cookie；`DEV_AUTH=1` 时方可使用 dev 登录 |
| 初始化状态 | `GET /api/setup/status` | 登录页唯一引导来源，返回当前最高优先级待办 |
| 管理端 | `/api/admin/supabase`、`/api/admin/overview`、`/api/admin/groups`、`/api/admin/storage`、`/api/admin/bindings`、`/api/admin/users`、`/api/admin/settings`、`/api/admin/audit`、`/api/admin/trash` | 管理员会话守卫；密钥类配置永不回明文 |
| 用户端文件 | `GET /api/files`、`POST /api/files/folder`、`POST /api/files/upload`、`GET /api/files/download`、重命名 / 移动 / 删除 / 搜索 | 先校验后落盘；配额拦截顺序：单文件上限 → 空间剩余 → 7 天上传流量 |
| 回收站 | `GET /api/trash`、`POST /api/trash/restore`、`DELETE /api/trash` | 软删保留 `TRASH_RETENTION_DAYS`（默认 30）天 |
| 分享 | `GET /api/shares`、`POST /api/shares`、`GET /api/share/:token` | 见 `docs/api-contract.md` 的 P3 段 |

## 版本进度

- **P0（已完成）**：仓库骨架、介绍页、文档与接口契约冻结。
- **P1（本轮）**：后端骨架与启动流程、登录引导状态机、管理端概览、上传 / 列表 / 下载 / 删除、配额与流量拦截、回收站软删与恢复、本地卷存储策略。
- **P2（已完成）**：S3 / GitHub 存储适配器、目录绑定与解析、管理端「文件系统」页（类型化表单 + 测试连接 + 健康状态）、密钥脱敏。
- **P3（已完成）**：分享（有效期 / 提取码 / 下载次数 / 目录分享）与在线预览（图片 / 视频 Range / 文本 / Markdown / PDF）。
- **P4（已完成）**：分片上传与断点续传（并发分片、断点续传、自动补齐）、流式打包下载、在线压缩 / 解压（防 zip slip），文件页多选批量操作与上传进度 UI。
- **P5（后端完成，前端部分待做）**：WebDAV（最小可用集）、应用密码、aria2 离线下载（可选）、OnlyOffice 只读预览（可选）、媒体元数据；PWA 与 i18n 未实现。
- **P6（已完成）**：站点级账号来源切换（`settings.userSource`，Supabase / 数据卷本地账号）、本地账号 scrypt 密码体系、管理员用户抽屉（封禁 / 改密 / 两种删号）。
- **P7（本轮）**：用户组级自助注册（`allow_self_signup`）、sudo 用户组（成员免管理密码进控制台）、配额单位 MB→EB（BigInt 精确换算）、版本发布流程（`VERSION` + `latest.json` + `tools/release.mjs` + 控制台更新提示）。

## 验证

接口与页面的实测记录在 [`docs/verify.md`](docs/verify.md)，截图在 [`docs/screenshots/`](docs/screenshots/)。两个可复现脚本：

```bash
# 28 项接口自检（需先启动服务）
BASE=http://127.0.0.1:8099 node tools/smoke-test.mjs

# 页面截图 + 前端断言（需要 puppeteer-core）
PUPPETEER_DIR=<含 puppeteer-core 的目录> BASE=http://127.0.0.1:8099 ADMIN_PASSWORD=<管理密码> node tools/capture.mjs
```

> 说明：沙箱环境没有 Docker 与真实 Supabase 实例，因此 `docker compose up` 与真实 Supabase 登录未实跑，验收口径见 `docs/verify.md` §2。

## 许可

- 本项目自身代码：[MIT](LICENSE)（Copyright © 2026 TanchiPanda）
- 随项目分发的依赖、以及计划接入的预览组件（pdf.js / Monaco / epub.js / Artplayer / Excalidraw / draw.io / Photopea / Google Docs Viewer / Microsoft Office 预览 / 7-Zip）的许可与使用边界，统一登记在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 引入新的第三方组件时，请同步在该文件登记；商用嵌入第三方在线服务前，先确认其条款允许（详见该文件第二节）。

## 合规声明

本项目功能思路参考了同类开源产品的常见做法，但**代码与界面全部自研**，未复制、未使用任何 GPL 或其它传染性许可证下的源码；运行时依赖均为 MIT / ISC / BSD 等宽松许可。
