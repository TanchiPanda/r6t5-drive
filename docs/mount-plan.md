# 第三方文件管理器挂载适配方案

> 本文为**待填写**的方案文档，作者手动补充。骨架已列出必须回答的问题，写完可直接作为实施依据。
>
> 状态：草稿 · 负责人：（待填） · 最后更新：2026-11-18

## 1. 目标与范围

- 要解决的问题：（待填：例如让用户用 Windows 资源管理器 / Finder / Infuse 直接挂载）
- 不做的事：（待填：例如不实现 SMB、不做桌面同步盘客户端）
- 成功标准：（待填：几条可验证的判定条件）

## 2. 协议选型

| 协议 | 是否做 | 理由 | 优先级 |
| --- | --- | --- | --- |
| WebDAV |  |  |  |
| S3 兼容网关 |  |  |  |
| FTP / SFTP |  |  |  |
| SMB |  |  |  |

结论：（待填）

## 3. 现状基线

对照 `server/routes/dav.js` 现状填写，避免方案建立在错误前提上。

| 能力 | 现状 | 缺口 | 处理 |
| --- | --- | --- | --- |
| 方法集 | OPTIONS/PROPFIND/GET/HEAD/PUT/DELETE/MKCOL/MOVE |  |  |
| COPY | 未实现 |  |  |
| LOCK / UNLOCK | 未实现 |  |  |
| PROPPATCH | 未实现 |  |  |
| 配额属性（quota-available-bytes 等） | 未暴露 |  |  |
| Range（206） | （待确认） |  |  |
| 认证方式 | 应用密码 |  |  |
| 路径根映射 | `data/volume/<邮箱>/` |  |  |

## 4. 兼容性需求矩阵

按客户端填“必须支持 / 可降级 / 不支持”，并写清原因。

| 客户端 | 平台 | 依赖的协议特性 | 已知坑 | 结论 |
| --- | --- | --- | --- | --- |
| Windows 资源管理器 | Windows |  | Basic 仅 HTTPS、WebClient 50MB 限制 |  |
| 访达 Finder | macOS |  | `.DS_Store`、100-continue |  |
| 文件 App | iOS/iPadOS |  |  |  |
| Solid Explorer / FolderSync | Android |  |  |  |
| RaiDrive | Windows |  | 并发 PROPFIND |  |
| Infuse / nPlayer | iOS/Apple TV |  | Range + ETag |  |
| rclone | 跨平台 |  | `--webdav-vendor other` |  |
| Cyberduck | macOS/Win |  |  |  |

## 5. 接口行为约定

逐条写死，避免实现时各写一套。

- PROPFIND 深度与 href 规则：（待填）
- 目录 href 是否以 `/` 结尾：（待填）
- 文件大小、时间、ETag 取值口径：（待填）
- PUT 原子写与 `If-Match` 语义：（待填）
- DELETE 与回收站的关系：（待填）
- MOVE 跨目录、覆盖策略：（待填）
- 405 的 `Allow` 头与错误码映射：（待填）
- 中文/特殊字符的百分号编码要求：（待填）

## 6. 安全模型

- 凭据：（待填：应用密码如何签发、绑定设备、撤销、封禁联动）
- 传输：（待填：是否强制 TLS、反代与证书要求）
- 隔离：（待填：账号根目录、越权防护、符号链接处理）
- 限流：（待填：并发连接、失败次数、带宽）
- 审计：（待填：记录哪些字段、保留多久）

## 7. 与加密存储（E 批）的关系

- 加密后 `getcontentlength` 报逻辑大小还是密文大小：（待填）
- Range 如何按分块解密：（待填）
- 明文/密文双态的判定位置：（待填）
- 迁移期兼容策略：（待填）

## 8. 代码落点

| 文件 / 模块 | 要改什么 | 风险 |
| --- | --- | --- |
| `server/routes/dav.js` |  |  |
| `server/lib/davxml.js` |  |  |
| `server/routes/apppasswords.js` |  |  |
| `server/services/quota.js` |  |  |
| `docs/verify.md` |  |  |

## 9. 里程碑与验收

| 阶段 | 交付 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| M1 补齐方法集 | COPY、LOCK/UNLOCK、配额属性 | curl 断言 |  |
| M2 客户端兼容 | 各端挂载可用 | 实机记录 |  |
| M3 安全加固 | 限流、审计、封禁联动 | 渗透自测 |  |
| M4 可选 S3 网关 | SigV4 服务端 | rclone/Cyberduck |  |

## 10. 未决问题

1. （待填）
2. （待填）
3. （待填）
