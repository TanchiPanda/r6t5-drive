# 存储驱动接口（P2 冻结版）

> 所有驱动必须实现本接口。`server/services/storage/driver.js` 是唯一分发入口，
> `files.js` / `trash.js` / `admin-storage.js` 只通过它访问存储，不直接 import 具体驱动。

## 1. 分发

```js
import { getDriver, driverCaps } from '../../services/storage/driver.js';

const driver = getDriver(strategy.type);   // 'volume' | 's3' | 'github'
driver.caps;   // { read: boolean, write: boolean, list: boolean }
```

- `volume`：read/write/list = true（list 走本地 fs 可选，当前节点元数据已足够，list 返回 []）
- `s3`：read/write/list = true
- `github`：read/list = true，**write = false**

## 2. 方法签名

| 方法 | 说明 |
|---|---|
| `ensureDir(strategy, logicalDir)` | 建目录。远端无目录概念时可为空实现（S3 直接返回） |
| `writeFromTemp(strategy, logicalPath, tmpFile, meta)` | 把本地临时文件写入策略。`meta = { size, mime, name }`。**必须流式**，禁止整文件读进内存 |
| `readStream(strategy, logicalPath, meta)` | 返回 `Readable`。`meta` 可能是 `{}`（远端条目没有本地节点记录） |
| `remove(strategy, logicalPath, meta)` | 删除单个文件（目录递归由调用方负责） |
| `rename(strategy, fromLogical, toLogical, meta)` | 同策略内改名/移动；S3 用 Copy+Delete，GitHub 抛只读 |
| `list(strategy, logicalDir)` | 列出该逻辑目录的**直接子项**，返回 `[{ name, path, type:'file'|'dir', sizeBytes, updatedAt|null, remote:true }]`；`path` 为逻辑路径（含 `<email>/`） |
| `test(strategy)` | 连通性自检，返回 `{ ok, message, details? }`，**不抛异常**（失败也返回 ok:false） |

## 3. 逻辑路径与对象键

- 逻辑路径恒为 `email/...`，驱动内部负责映射到各自的键空间：
  - `volume`：`<rootPath>/<email>/...`（已有实现）
  - `s3`：`<prefix>/<email>/...`（prefix 为空则直接 `<email>/...`）
  - `github`：`<rootPath>/<email>/...`（rootPath 为仓库内目录）
- 驱动必须自己保证键不逃出策略根（`..`、绝对路径由 `lib/paths.js` 上游已拦，驱动再加一道）

## 4. 错误约定

| 场景 | 抛出 |
|---|---|
| 只读策略的写操作 | `ApiError(403,'strategy_readonly',…)` |
| 上游返回错误 | `ApiError(502,'upstream_error', …, { provider, status, op })` |
| 对象不存在 | `ApiError(404,'not_found',…)` |
| 驱动不支持该操作 | `ApiError(400,'storage_unsupported', …)` |

## 5. 策略解析优先级（`server/services/bindings.js`）

1. **最深匹配的目录绑定**（用户级绑定优先于站点级绑定，同一深度时）
2. **用户组默认策略**（`groups.defaultStrategyId`）
3. **站点本地默认**（`settings.defaultStorageId`，未设置则取第一个启用的 volume 策略）

命中结果统一返回 `{ strategy, matchedBy: 'binding'|'group'|'local', bindingId?, depth }`，
文件列表接口把这个结果原样返回给前端展示「当前目录落在哪个策略上」。
