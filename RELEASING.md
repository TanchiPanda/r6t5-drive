# 发布流程（RELEASING）

本项目通过「GitHub issue + 评论 + 仓库根目录 `latest.json`」三者关联来承载版本发布信息；
管理控制台读取 `latest.json` 与本地 `VERSION` 对比后展示更新提示。本文面向发版操作者。

## 1. 每次发版必须做的三步

1. **改版本号**：编辑仓库根目录 `VERSION`（单行，去空白）。格式为 `YYYYMMDD` + 小写字母后缀，
   例如 `20261115a`（同一天内多次构建依次递增 `b`、`c`……）。
2. **跑发布脚本**（需要有 `repo` scope 的 PAT，只通过环境变量传入，不要写进任何文件）：

   ```bash
   GITHUB_TOKEN=<PAT> node tools/release.mjs
   ```

   脚本会：读取 `VERSION` 与 git 历史 → 在
   [TanchiPanda/r6t5-drive](https://github.com/TanchiPanda/r6t5-drive/issues) 创建
   `Release <version>` issue → 在该 issue 下创建一条发布评论 → 把
   `issueNumber` / `commentId` / `commentUrl` / `publishedAt` / `notes` 写回 `latest.json`。
   **两次 GitHub 请求都必须返回 HTTP 201**，脚本才会写 `latest.json`；任一步失败都不会覆盖已有文件。
3. **提交并推送**：确认 `latest.json` 与 `VERSION` 已变更，随本轮代码一起提交并推送到 `main`。
   控制台更新提示依赖远端 `main` 分支上的 `latest.json`，不推送则其他实例检查不到新版本。

## 2. issue / 评论 / 版本三者的对应关系

| 产物 | 位置 | 承载内容 | 关联键 |
|---|---|---|---|
| `VERSION` | 仓库根，单行文本 | 本机（当前容器）构建号 | — |
| Issue | GitHub 仓库 issues 列表 | 标题为 `Release <version>`；正文含版本号、构建时间、变更摘要、升级命令 | `latest.json.issueNumber` |
| 发布评论 | 该 issue 下的**唯一一条**评论 | 发布说明：变更要点、升级命令、回滚提示 | `latest.json.commentId` + `commentUrl` |
| `latest.json` | 仓库根 JSON | 机器可读的版本元数据，供后端更新检查接口拉取 | 通过 `issueNumber` + `commentId` 指回 issue 与评论 |

约束：

- 一个版本对应一个 release issue；issue 下只保留一条发布说明评论（重发版时新建 issue，不要复用旧 issue）。
- `latest.json` 的字段顺序固定为：`version`, `issueNumber`, `commentId`, `commentUrl`,
  `publishedAt`, `upgradeCommand`, `notes`；由脚本写出，2 空格缩进、末尾换行。
- 后端不做版本号大小比较：远端 `version` 字符串与本地 `VERSION` 不同即提示有更新（构建号非语义化版本）。

## 3. 无 token / 先验证逻辑：`--dry-run`

```bash
node tools/release.mjs --dry-run
```

dry-run 不发送任何网络请求，不读取 `GITHUB_TOKEN`，只打印：将要创建的 issue 标题与正文、
将要创建的评论正文、以及将要写入的 `latest.json` 内容；退出码 0。没有 token 的环境（CI、本地自测）
可以用它核对变更摘要与文案。

降级行为：

- 缺少 `GITHUB_TOKEN`（非 dry-run）：脚本立即退出码 1，并说明用法；不写 `latest.json`。
- 创建 issue 失败：打印 HTTP 状态码与响应体前 500 字，退出码 1，不改动已有 `latest.json`。
- 创建评论失败：issue 已创建时会在报错中给出 issue 链接；`latest.json` 不写入，可手动补评论后重跑，
  或删除半成品 issue 后重新发版。

## 4. 升级与回滚

本仓库为 Docker Compose 自托管部署，统一升级命令：

```bash
docker compose pull && docker compose up -d
```

回滚到上一个版本（在代码仓库目录内执行）：

```bash
docker compose down && git checkout <上一个版本号或 tag> && docker compose up -d
```

> 回滚前先备份 `data/` 目录（元数据库与上传文件）；后端启动时自动执行 SQLite 迁移，
> 跨版本回滚若涉及 schema 变更，以备份恢复为准。详见 `docs/deploy.md` §5。

## 5. 相关文件

- `tools/release.mjs`：发布脚本（零依赖，Node 22 ESM）。
- `latest.json`：发布元数据（脚本回写，禁止手工编辑键名/顺序）。
- `server/routes/admin-update.js`：管理端更新检查接口（挂载点在 `server/app.js` 整合阶段接入）。
- `docs/release.md`：接口与 `latest.json` 字段的技术契约。
