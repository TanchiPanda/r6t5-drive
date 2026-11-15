# 版本发布技术说明

面向维护者：说明 `latest.json` 契约、更新检查接口的返回结构、缓存策略、离线降级与
`hasUpdate` 判定规则。操作流程见仓库根目录 [`RELEASING.md`](../RELEASING.md)。

## 1. 版本标识

- `VERSION`（仓库根，单行）：本机构建号，格式 `YYYYMMDD` + 小写字母后缀，如 `20261115a`。
  构建号**不是语义化版本**，后端不解析大小、不做区间比较，只做字符串相等判断。
- `latest.json`（仓库根，`main` 分支）：最近一次发布的机器可读元数据，由
  `tools/release.mjs` 在发版时回写；后端通过 raw.githubusercontent.com 拉取。

## 2. `latest.json` 字段契约

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | 发布构建号，与该次发版的 `VERSION` 一致 |
| `issueNumber` | number \| null | GitHub release issue 编号 |
| `commentId` | number \| null | issue 下发布评论的评论 ID（GitHub comment node id 之外的数字主键） |
| `commentUrl` | string | 评论的 `html_url`，前端可直接跳转 |
| `publishedAt` | string \| null | 发布时间，ISO 8601 UTC |
| `upgradeCommand` | string | 统一升级命令：`docker compose pull && docker compose up -d` |
| `notes` | string | 一句话变更摘要（取最近一条提交标题，截断到 120 字） |

字段顺序固定：`version`, `issueNumber`, `commentId`, `commentUrl`, `publishedAt`,
`upgradeCommand`, `notes`；文件 2 空格缩进、末尾换行。首次发版前允许
`issueNumber` / `commentId` / `commentUrl` / `publishedAt` / `notes` 为空值占位。

## 3. 接口：`GET /api/admin/update-status`

挂载：`adminApi.use('/update-status', adminUpdateRouter)`，与其他管理接口一样由
`requireAdminApi` 守卫（401 未登录 / 403 越权在守卫层处理，本路由不重复鉴权）。

### 3.1 远端可达且解析成功

HTTP 200：

```json
{
  "checked": true,
  "current": {
    "version": "20261115a",
    "builtAt": "2026-11-15T02:10:00.000Z",
    "serverTime": "2026-11-15T03:00:00.000Z"
  },
  "latest": {
    "version": "20261115b",
    "issueNumber": 1,
    "commentId": 2,
    "commentUrl": "https://github.com/TanchiPanda/r6t5-drive/issues/1#issuecomment-2",
    "publishedAt": "2026-11-15T02:30:00.000Z",
    "upgradeCommand": "docker compose pull && docker compose up -d",
    "notes": "修复分片上传并发丢片"
  },
  "hasUpdate": true,
  "cached": false
}
```

- `current.version`：本地 `VERSION` 内容；`current.builtAt`：`VERSION` 文件 mtime 的 ISO 时间；
  `current.serverTime`：本次请求时刻。
- `latest.*`：远端 `latest.json` 归一化后的字段；缺失字段补 `null` / 空串。
- `cached`：本次结果是否来自进程内缓存（true 时未发起远端请求）。

### 3.2 离线 / 远端异常 / JSON 非法

一律 **HTTP 200**，不抛 5xx、不报错弹窗：

```json
{
  "checked": false,
  "reason": "network",
  "current": { "version": "20261115a", "builtAt": "...", "serverTime": "..." },
  "cached": false
}
```

`reason` 枚举：

| 值 | 含义 |
|---|---|
| `network` | 网络不可达、DNS 失败、请求超时（5s）等 fetch 层错误 |
| `http_<code>` | 远端返回非 200（如 `http_404`：`latest.json` 尚未推到 `main`） |
| `invalid_json` | 响应体不是合法 JSON，或缺少字符串 `version` 字段 |

### 3.3 `hasUpdate` 判定规则

- `hasUpdate = current.version !== latest.version`（字符串不等即 true）。
- 本地 `VERSION` 缺失（空串）时 `hasUpdate` 为 false，避免误报。
- **不做**语义化版本大小比较：构建号后缀（`a`/`b`/`c`）不参与排序，历史上回退过版本时
  只要字符串不同就会提示更新，这是预期行为。

## 4. 缓存策略

- 缓存仅存于当前进程内存，**不落盘、不跨进程共享**；服务重启后缓存清空。
- 成功结果缓存 **5 分钟**；失败结果缓存 **60 秒**（避免离线环境下每个请求都等 5s 超时）。
- 缓存命中时 `cached: true`，响应结构与真实请求一致。
- 远端地址固定为
  `https://raw.githubusercontent.com/TanchiPanda/r6t5-drive/main/latest.json`，请求超时 5s，
  跟随重定向。

## 5. 发布脚本要点（`tools/release.mjs`）

- Node 22 ESM，零依赖（内置 `fetch` / `fs` / `child_process`）。
- 变更摘要真实读取 git 历史：优先取上一个发布版本（tag `v<prev>` / 提交信息
  `Release <prev>`）之后的提交；定位不到基线时回退最近 20 条 `git log --oneline`。
- GitHub 请求：`POST /repos/TanchiPanda/r6t5-drive/issues` 创建 issue，
  `POST .../issues/<n>/comments` 创建评论；两次都返回 **201** 后才写 `latest.json`。
- 写文件先落 `.tmp` 再 `rename`（原子替换），失败不会写坏已有 `latest.json`。
- PAT 仅从环境变量 `GITHUB_TOKEN` 读取；仓库文件内不得出现 token 明文。
- `--dry-run`：不发网络请求、不读 token，打印待创建内容与待写 JSON，退出码 0。

## 6. 未纳入本范围

- 前端控制台提示组件、轮询间隔与跳转链接（前端产线负责）。
- 真实 `docker compose pull && docker compose up -d` 的执行（由部署方在主机上完成）。
- 路由在 `server/app.js` 的挂载代码（整合阶段添加）。
