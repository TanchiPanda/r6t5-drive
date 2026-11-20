# 部署说明（R6T5 Drive）

本文覆盖反向代理、HTTPS、备份、升级、迁移与多站点部署，以及常见故障排查。应用本体通过 `docker compose up -d` 启动，数据统一落在宿主 `./data` 目录。

## 1. 前置准备

- Docker Engine 与 Docker Compose 插件
- 一个可访问的 Supabase 项目（用于账号体系；地址与密钥在后台填写，不写进 `.env`）
- 端口规划：默认应用 `5212`；可选侧车端口见 `docker-compose.yml` 注释块

```bash
cp .env.example .env
# SESSION_SECRET 用 openssl rand -hex 32 生成并填入；其余项按注释调整
docker compose up -d
docker compose logs -f drive    # 首次启动若未设 ADMIN_PASSWORD，在此查看自动生成的管理密码
```

### Windows（PowerShell / CMD）

Windows 下没有 `$(...)` 命令替换，路径分隔符也不同，不要直接复制 Linux 那行。先把数据目录建出来，再按终端选一条：

```powershell
# PowerShell：1) 建数据目录 2) 启动
New-Item -ItemType Directory -Force -Path .\data | Out-Null
docker run -d --name r6t5-drive -p 5212:5212 `
  -v "${PWD}\data:/app/data" `
  -e "TZ=Asia/Shanghai" `
  ghcr.io/tanchipanda/r6t5-drive:latest
```

```bat
REM CMD
mkdir data
docker run -d --name r6t5-drive -p 5212:5212 -v "%cd%\data:/app/data" -e "TZ=Asia/Shanghai" ghcr.io/tanchipanda/r6t5-drive:latest
```

需要显式给会话密钥时（PowerShell，本机不一定有 openssl）：

```powershell
-e "SESSION_SECRET=$([guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N'))"
```

`SESSION_SECRET` 不传也可以：程序会生成随机密钥并落盘到 `data/`，重启继续沿用；删掉 `data` 则旧会话失效。

查看首启日志拿管理员密码：`docker logs r6t5-drive`。

## 2. 反向代理

应用默认监听容器内 `5212`。放在 Nginx / Caddy 后面时，**必须关闭请求体缓冲并放开上传大小限制**，否则大文件上传会被代理层截断或返回 413。

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name drive.example.com;

    ssl_certificate     /etc/ssl/drive.example.com.crt;
    ssl_certificate_key /etc/ssl/drive.example.com.key;

    # 放开上传大小限制：0 表示不限制（限制交给应用内的单文件配额）
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:5212;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP          $remote_addr;
        proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto  $scheme;

        # 关闭请求体缓冲：大文件直连后端流式上传，不在 Nginx 落临时盘
        proxy_request_buffering off;

        # 长连接 / 下载流式响应的超时放宽
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

### Caddy

```caddy
drive.example.com {
    reverse_proxy 127.0.0.1:5212 {
        # 放开请求体大小并关闭缓冲
        header_up X-Forwarded-Proto {scheme}
        flush_interval -1
    }
    request_body {
        max_size -1
    }
}
```

> 说明：应用自身按用户组配置单文件上限，超限返回 `413 quota_file`；代理层的 `client_max_body_size` / `max_size` 是第二道闸，不要在这里另设过小的值。

## 3. HTTPS

- 生产环境务必经反向代理启用 HTTPS（Let's Encrypt 证书或内部 CA）。
- 会话 Cookie 为 `SameSite=Lax`；站点经 HTTPS 对外提供时，登录态在跨站跳转下表现正常。
- Supabase 配置中的 `url` 需为可从服务端访问的地址；若使用自定义域名，保证后端网络可达。

## 4. 数据备份

所有持久化数据都在 `data/` 目录：`data/r6t5.db`（元数据）、`data/volume/`（本地卷文件）。

### 方式 A：停容器后整目录备份（一致性最好）

```bash
docker compose stop drive
tar -czf r6t5-drive-backup-$(date +%Y%m%d).tar.gz data/
docker compose start drive
```

### 方式 B：在线备份 SQLite（不停机）

SQLite 支持在线一致备份，文件本体仍单独打包：

```bash
# 在容器内调用 sqlite 的 .backup 命令（better-sqlite3 同库文件）
docker compose exec drive node -e "
const Database = require('better-sqlite3');
const src = new Database(process.env.DB_PATH || 'data/r6t5.db', {readonly:true});
src.backup(process.env.DB_PATH || 'data/r6t5.db' + '.bak').then(()=>{console.log('db backup ok')});
"
# 再打包 data/volume 与生成的 .bak
```

- 备份频率按站点规模定；元数据库小，可每日备份，文件目录按变更增量同步。
- 恢复：把备份解包回 `data/`，确认目录属主与权限后启动容器。

## 5. 升级流程

```bash
# 1. 先备份（见上一节）
# 2. 拉取新代码 / 新镜像
git pull
docker compose build --no-cache drive

# 3. 滚动重启
docker compose up -d drive

# 4. 查看启动日志，确认迁移完成、无报错
docker compose logs -f drive
```

- 后端启动时自动执行 SQLite 迁移；升级前不要手改 `schema.sql`。
- 若新版本调整了环境变量，对照 `.env.example` 补全后再启动。

## 6. 迁移到新机器

1. 旧机器：按「方式 A」停容器并打包 `data/`。
2. 新机器装好 Docker，拉取同版本代码。
3. 解包 `data/` 到新机器工程目录；复制并核对 `.env`（`SESSION_SECRET` 沿用旧值，否则旧会话全部失效）。
4. `docker compose up -d`，登录后台核对 Supabase 配置、用户组与存储策略。
5. 旧机器确认无流量后再下线。

## 7. 多站点部署

每个站点是一套独立 compose + 独立数据卷 + 独立端口，互不共享元数据与文件：

```
/srv/drive-site-a/
├── docker-compose.yml     # ports: "5212:5212"
├── .env                   # 独立 SESSION_SECRET
└── data/                  # 独立 data 卷
/srv/drive-site-b/
├── docker-compose.yml     # ports: "8090:5212"
├── .env
└── data/
```

- 端口冲突时只改宿主映射左侧端口（如 `"8090:5212"`），容器内端口保持 `5212`。
- 各站点可对接不同 Supabase 项目或同一项目下的不同用户体系；存储策略各自独立配置。

## 8. 常见故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 首次登录找不到管理密码 | `ADMIN_PASSWORD` 留空，密码仅启动时打印一次 | 看 `docker compose logs drive` 启动日志；找不到则在 `.env` 显式设置 `ADMIN_PASSWORD` 后重启 |
| 登录返回 401 `invalid_credentials` | 邮箱 / 密码与 Supabase 不一致；或 Supabase 未配置 | 先访问 `/api/setup/status` 确认 `supabase` 已通过自检；核对账号密码 |
| 登录返回 401 `invalid_admin_password` | 管理密码错误 | 查日志中的生成密码，或重置 `.env` 中 `ADMIN_PASSWORD` 后重启 |
| 上传返回 413 `quota_file` | 超过用户组单文件上限 | 在管理端调高该组 `maxFileSizeBytes`；注意区分应用 413 与代理层 413 |
| 上传被代理返回 413 / 中断 | Nginx / Caddy 默认限制请求体 | 配置 `client_max_body_size 0`、`proxy_request_buffering off`（见第 2 节） |
| 登录返回 412 `supabase_not_configured` | 后台尚未填 Supabase 配置 | 管理员进入后台完成 Supabase 配置并通过自检 |
| 保存 Supabase 返回 400 `supabase_unreachable` | URL / anon key / service key 任一项校验失败，或服务端网络不通 | 按自检 `details.reason` 逐项核对；确认容器能访问 Supabase 域名；失败不写库，可放心重试 |
| 磁盘满 / 上传报 `storage_error` | 宿主数据盘写满，或目录权限不足 | 清理回收站与无关文件；检查 `data/` 所属用户与写权限；容器以非 root 用户运行 |
| 页面 403 且提示无权限 | 普通用户访问了 `/admin/**` | 属预期守卫；管理后台需管理员会话 |
| 健康检查不通过 | 进程未起来 / 端口未监听 | `docker compose logs drive` 看启动报错；核对 `PORT` 与端口映射 |
| 升级后旧会话失效 | `SESSION_SECRET` 变更 | 沿用原密钥；用户重新登录即可 |

## 9. WebDAV 挂载

应用内置一个最小可用 WebDAV 端点，供 macOS Finder、Windows 资源管理器及第三方 WebDAV 客户端直接挂载。鉴权使用 **HTTP Basic**：用户名是账号邮箱，密码是在「账号 → 应用密码」里生成的应用密码（不是登录密码）。

### 9.1 连接信息

| 项 | 值 |
|---|---|
| 挂载地址 | `http://<host>:5212/dav`（反代到 HTTPS 时用 `https://<host>/dav`） |
| 用户名 | 账号邮箱（如 `alice@example.com`） |
| 密码 | 应用密码（`r6t5-XXXX-XXXX-XXXX` 形式，仅生成那一次明文可见） |

> WebDAV 端点只认应用密码 Basic Auth，不接受浏览器会话 Cookie；在客户端里填应用密码即可。

### 9.2 反向代理注意事项

WebDAV 依赖 `PROPFIND`、`MKCOL`、`MOVE` 等方法与 `Destination` 头，反代时需要保留：

- 放行 `PROPFIND`、`MKCOL`、`MOVE`、`COPY`、`LOCK` 等 WebDAV 方法（不要只代理 GET/POST/PUT/DELETE）；
- 透传 `Destination`、`Overwrite`、`Depth` 等请求头；
- 沿用第 2 节的关闭请求体缓冲、放开上传大小限制配置。

Nginx 示例（在已有 `location /` 基础上确认方法与头未被过滤）：

```nginx
location /dav {
    proxy_pass http://127.0.0.1:5212;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP          $remote_addr;
    proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto  $scheme;

    # 透传 WebDAV 必需头
    proxy_set_header Destination        $http_destination;
    proxy_set_header Overwrite          $http_overwrite;
    proxy_set_header Depth              $http_depth;

    proxy_request_buffering off;
    proxy_buffering off;
    client_max_body_size 0;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

### 9.3 macOS Finder

1. 打开 **Finder**，菜单栏 **前往 → 连接服务器**（快捷键 `⌘K`）。
2. 服务器地址填 `http://<host>:5212/dav`，点 **连接**。
3. 认证方式选 **注册用户**：
   - 名称：账号邮箱；
   - 密码：应用密码。
4. 点 **连接**，即可在 Finder 中浏览、上传、下载与改名。

> 若 Finder 提示无法连接，确认地址末尾是 `/dav`；HTTPS 站点用 `https://<host>/dav`。

### 9.4 Windows 资源管理器

1. 打开 **此电脑**，顶部 **计算机 → 映射网络驱动器**（或右键 **此电脑 → 映射网络驱动器**）。
2. 文件夹地址填：
   - `\\<host>@5212\dav`（本机/局域网直连示例：`\\127.0.0.1@5212\dav`）；
   - 经 HTTPS 反代时，部分版本需用 `https://<host>/dav` 形式。
3. 勾选 **使用其他凭据连接**，在弹出的 Windows 安全提示里输入：
   - 用户名：账号邮箱；
   - 密码：应用密码。
4. 完成后盘符下即出现 WebDAV 目录。

> Windows 自带 WebDAV 客户端默认走 **Basic 认证**；若站点只放行 NTLM/协商认证，需要在客户端侧或策略上允许 Basic。家庭/内网直连通常无需额外配置。

### 9.5 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 挂载后弹出认证框，反复返回 401 | 密码填成了登录密码，或应用密码已被撤销 | 到「账号 → 应用密码」重新生成一条，用新密码挂载；确认该应用密码未撤销 |
| 新建目录 / 上传返回 409 | 父目录不存在（WebDAV 语义：不会自动补上级目录） | 先在客户端或网页端建好上级目录，再写入 |
| 上传 / 改名 / 删除返回 403 `strategy_readonly` | 目标目录绑定的是只读存储策略（如 GitHub 归档） | 只读策略下不能写入、删除或改名；换到可写目录操作 |
| 大文件上传中断 / 413 | 代理层限制了请求体，或超出用户组单文件配额 | 按第 2 节关闭代理缓冲并放开 `client_max_body_size`；超限属应用配额，需调高用户组上限 |
| Finder/资源管理器列目录为空 | 对端策略为远端只读仓库且本地无元数据，或目录本身为空 | 先用网页端确认该目录下有文件；远端列举失败时会降级为空态 |

## 10. 运行日志

服务端所有运行日志都写 stdout，`docker compose logs` 即可查看；容器不需要额外挂载日志文件。

### 10.1 日志格式

每行一个事件，结构固定，便于 grep / awk：

```
2026-11-20 11:59:26 CHG  [audit] 上传文件 action=upload user=log@example.com target=log@example.com/f.txt bytes=10 ip=127.0.0.1
2026-11-20 11:59:29 WARN [http] POST /api/files/mkdir status=404 ms=2 user=log@example.com ip=127.0.0.1
```

| 级别 | 含义 |
|---|---|
| `INFO` | 启动、扫描、定时任务等例行信息 |
| `CHG` | **有变更**：登录、设置保存、上传/删除/移动、分享、订单、积分、兑换码等 |
| `WARN` | 客户端错误（4xx）：密码错、权限不足、配额超限、路由不存在 |
| `ERR` | 服务端错误（5xx）与未捕获异常 |

标签：`[boot]` 启动、`[audit]` 业务变更（与审计表同源）、`[http]` 未落审计的写请求兜底、`[uploads]` 分片清理、`[cron]` 定时任务。

### 10.2 常用过滤

```bash
docker compose logs -f drive                 # 实时跟踪
docker compose logs drive | grep ' CHG '     # 只看变更
docker compose logs drive | grep '[audit]'   # 只看业务动作（含操作者与目标）
docker compose logs drive | grep 'ERR '      # 只看错误
docker compose logs drive | grep 'user=alice@example.com'   # 按账号追踪
docker compose logs drive | grep 'action=settings_update'   # 只看设置变更
```

### 10.3 日志级别

| 环境变量 | 效果 |
|---|---|
| `LOG_LEVEL=info`（默认） | 输出 INFO / CHG / WARN / ERR |
| `LOG_LEVEL=warn` | 只输出 WARN / ERR（安静模式） |
| `LOG_LEVEL=error` | 只输出 ERR |

> 日志不记录密码、会话 Cookie、应用密码、OAuth token 与文件内容；`CHG` 行里的 `detail` 只包含动作来源（如 `local`、`sudo`、`siteName` 这类键名）。

## 11. 在线打开方式（Office / PDF）

文件预览默认只读，按类型走不同通道；管理员可在「设置 → 预览」切换。

| 类型 | 方式 | 说明 |
| --- | --- | --- |
| PDF | `pdfjs`（默认） | 内置 PDF.js（`public/vendor/pdfjs/`，Apache-2.0），支持翻页与缩放，不依赖外网 |
| PDF | `native` | 交给浏览器内置阅读器（iframe），兼容性最好但样式不可控 |
| Office（doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp/rtf） | `none`（默认） | 不提供在线打开，只能下载 |
| Office | `gdocs` | 嵌入 Google Docs Viewer，文件由 Google 读取 |
| Office | `m365` | 嵌入 Microsoft 365（Office for the web），文件由微软读取 |

启用外部打开方式的前提：

1. 「设置 → 站点 → 对外地址」必须填公网可访问的 `publicUrl`（`http://localhost`、`127.0.0.1`、内网段会被拒绝）；
2. 文件通过 `/api/embed/file?t=<随机令牌>` 免登录读取，令牌 10 分钟过期、进程重启即失效、不含邮箱与路径明文；
3. 每次打开会写审计 `embed_open` 与日志 `CHG [embed] 生成外部预览链接`；
4. 外部服务可能缓存或记录文件内容，私有文件建议保持 `none` 或改用 OnlyOffice 自托管。
