# R6T5 Drive 架构与实施计划

## 1. 总体结构

```
浏览器 ──► app.html（静态页）
             │ 1. Hub 登录换 JWT
             ▼
      Worker: r6t5-drive-api
        ├─ /api/sign      直传签名（R2 / S3 预签名 URL）
        ├─ /api/files     列表 / 建目录 / 重命名 / 删除
        ├─ /api/share     创建与校验分享
        └─ /api/quota     容量统计
             │
      Supabase（元数据） + 对象存储（文件本体）
```

文件本体**不经过 Worker**：前端拿签名 URL 直传对象存储，Worker 只写元数据与鉴权。

## 2. 数据表（草案）

```sql
create table drive_users (
  uid          text primary key,          -- Hub 邮箱
  display_name text,
  quota_bytes  bigint default 10737418240,
  used_bytes   bigint default 0,
  created_at   timestamptz default now()
);

create table drive_nodes (                 -- 文件与目录同表
  id         uuid primary key default gen_random_uuid(),
  uid        text references drive_users(uid) on delete cascade,
  parent_id  uuid references drive_nodes(id),
  name       text not null,
  is_dir     boolean default false,
  size       bigint default 0,
  hash       text,                         -- 内容哈希，用于秒传
  storage_key text,                        -- 对象存储里的 key
  mime       text,
  deleted_at timestamptz,                  -- 回收站
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (uid, parent_id, name)
);

create table drive_shares (
  id         uuid primary key default gen_random_uuid(),
  node_id    uuid references drive_nodes(id) on delete cascade,
  token      text unique not null,
  password   text,                         -- 可为空
  expires_at timestamptz,
  max_downloads int,
  downloads  int default 0,
  created_at timestamptz default now()
);

create table drive_audit (
  id         bigserial primary key,
  uid        text,
  action     text,
  target     text,
  ip_hash    text,
  at         timestamptz default now()
);
```

## 3. 关键决定

| 议题 | 结论 | 理由 |
|---|---|---|
| 文件走不走 Worker | 不走 | R2 无出口费，直传省 Worker 请求与 100MB 限制 |
| 鉴权 | Hub JWT | 一处登录，生态内通用 |
| 秒传 | `hash` 命中即复用 `storage_key` | 同文件只存一份 |
| 回收站 | `deleted_at` 软删，定时任务 30 天后真删 | 误删可恢复 |
| 分享 | 独立 token + 可选密码 | 不进主站路由，便于审计 |

## 4. 分期

- **P0** 骨架（已完成）：仓库、介绍页、README、本计划
- **P1** 上传 / 列表 / 下载 / 删除；JWT 校验；R2 后端
- **P2** 目录树、分享、回收站、秒传
- **P3** Docker 自托管 + S3/WebDAV 适配
- **P4** 配额与团队空间、开放 API

## 5. 待定

- 默认存储：R2（无出口费）还是 S3（兼容性广）
- 免费额度：10GB / 账号？
- 是否用钱包积分兑换容量
- 是否绑定 `drive.r6t5.dpdns.org`（需你确认后再加 CNAME）
