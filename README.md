# R6T5 Drive

自运营的网盘服务：文件存在自己的对象存储里，账号走 **R6T5 Hub 通行证**，可按需 Docker 自托管。

- 站点：https://rtdocs.r6t5.dpdns.org （介绍页由本仓库 GitHub Pages 提供）
- 仓库：https://github.com/TanchiPanda/r6t5-drive

## 设计要点

| 层 | 选型 | 说明 |
|---|---|---|
| 鉴权 | R6T5 Hub | 账号中心签发 JWT，Drive 只校验 `sub`（邮箱） |
| 元数据 | Supabase（国际节点） | 文件树、分享、回收站、配额 |
| 存储 | Cloudflare R2 / S3 / WebDAV / 本地磁盘 | 可替换，按配置选后端 |
| 接口 | Cloudflare Worker | 直传签名、分享校验、配额统计 |
| 前端 | 静态页 + 少量 JS | 与文档站同一套视觉与主题系统 |

## 目录规划

```
index.html          介绍页（当前）
app.html            网盘主界面（P1）
assets/             样式与前端脚本
worker/             API：签名、分享、配额
schema.sql          元数据表结构
docker/             Dockerfile 与 compose 示例
docs/               架构与部署文档
```

## 路线图

- **P0** 项目骨架与介绍页（已完成）
- **P1** 上传 / 列表 / 下载 / 删除（单用户空间）
- **P2** 目录树、分享链接、回收站、秒传去重
- **P3** Docker 自托管与多存储后端
- **P4** 配额、团队空间、开放 API

## 待定

- 默认存储后端（R2 还是 S3）
- 免费额度与付费扩容口径
- 是否与 r6t5-wallet 打通（积分换容量）
