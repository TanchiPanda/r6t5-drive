# 部署说明（R6T5 Drive）

本文覆盖反向代理、HTTPS、备份、升级、迁移与多站点部署，以及常见故障排查。应用本体通过 `docker compose up -d` 启动，数据统一落在宿主 `./data` 目录。

## 1. 前置准备

- Docker Engine 与 Docker Compose 插件
- 一个可访问的 Supabase 项目（用于账号体系；地址与密钥在后台填写，不写进 `.env`）
- 端口规划：默认应用 `8080`；可选侧车端口见 `docker-compose.yml` 注释块

```bash
cp .env.example .env
# SESSION_SECRET 用 openssl rand -hex 32 生成并填入；其余项按注释调整
docker compose up -d
docker compose logs -f drive    # 首次启动若未设 ADMIN_PASSWORD，在此查看自动生成的管理密码
```

## 2. 反向代理

应用默认监听容器内 `8080`。放在 Nginx / Caddy 后面时，**必须关闭请求体缓冲并放开上传大小限制**，否则大文件上传会被代理层截断或返回 413。

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
        proxy_pass http://127.0.0.1:8080;
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
    reverse_proxy 127.0.0.1:8080 {
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
├── docker-compose.yml     # ports: "8080:8080"
├── .env                   # 独立 SESSION_SECRET
└── data/                  # 独立 data 卷
/srv/drive-site-b/
├── docker-compose.yml     # ports: "8090:8080"
├── .env
└── data/
```

- 端口冲突时只改宿主映射左侧端口（如 `"8090:8080"`），容器内端口保持 `8080`。
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
