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

## 6. P9-D1 新增厂商适配器（OSS / COS / KS3 / OBS / 七牛 / 又拍）

> 签名核心复用 `server/services/storage/sigv4.js`（SigV4 派生密钥与规范请求只实现一份）；
> SigV4 家族工厂在 `sigv4-family.js`，各家差异通过 spec 注入。七牛 / 又拍为非 SigV4 自定义鉴权。
> **未验证声明**：以下六家仅在本地假服务 `tools/fake-objstore.mjs` 上校验了签名 / 鉴权头构造、
> 路径与时间戳格式；**真实 OSS / COS / KS3 / OBS / 七牛 / 又拍服务均未联调**，上线前需用真实凭证复测。

### 6.1 能力矩阵

| 适配器 | get(读) | put(写) | delete | list | stat(HEAD) | range(分段读) | presign | rename |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| volume（本地卷） | ✓ | ✓ | ✓ | ✗（本地元数据为准） | ✗ | ✗ | ✗ | ✓ |
| s3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| github | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| oss（阿里云） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| cos（腾讯云） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| ks3（金山云） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| obs（华为云） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| qiniu（七牛云） | ✓ | ✗ `upload_not_supported` | ✓ | ✗ `driver_not_supported` | ✓ | ✓ | ✗ | ✗ |
| upyun（又拍云） | ✓ | ✗ `upload_not_supported` | ✓ | ✗ `driver_not_supported` | ✓ | ✓ | ✗ | ✗ |

- 不支持的能力**显式抛错**，绝不静默降级：写入通道未实现 → `400 upload_not_supported`；
  列举 / 改名 / 预签名等未实现操作 → `400 driver_not_supported`（`details.capability` 指明能力名）。
- `presign` 全系列当前均未实现（含 s3）；后续扩展点见 `driver.presign()` 占位。

### 6.2 签名 / 鉴权差异（每家一行公式）

| 适配器 | 鉴权方案 | 签名公式与关键头 | 默认 Host 形态 |
|---|---|---|---|
| oss | SigV4 变体 | `Credential=<ak>/<date>/<region>/oss/aws4_request`；时间戳头 `x-oss-date`，内容哈希 `x-oss-content-sha256` | `<bucket>.<region>.aliyuncs.com`（region 如 `oss-cn-hangzhou`） |
| cos | SigV4 近似 S3 | scope service 固定 `cos`；时间戳头 `x-cos-date`，内容哈希 `x-cos-content-sha256` | `<bucket>-<appid>.cos.<region>.myqcloud.com`（region 如 `ap-guangzhou`） |
| ks3 | SigV4 变体 | Authorization 方案名 `KSS`；时间戳头 `x-kss-date`，内容哈希 `x-kss-content-sha256` | `<bucket>.<region>.ksyuncs.com`（region 如 `ks3-cn-beijing`） |
| obs | SigV4 兼容 | 时间戳头 `x-obs-date`，内容哈希 `x-obs-content-sha256` | `<bucket>.obs.<region>.myhuaweicloud.com`（region 如 `cn-north-4`） |
| qiniu | QBox 管理凭证（**非 SigV4**） | `sign = Base64(HMAC-SHA1(secretKey, "<METHOD>\\n<URI>\\n<Body>"))`；`Authorization: QBox <accessKey>:<sign>` | 由 `endpoint` 决定（默认 `https://rs.qiniu.com`） |
| upyun | UPYUN REST v2（**非 SigV4**） | `signature = MD5("<METHOD>&<URI>&<DATE>&<POLICY>&<MD5(Body)>")`；`Authorization: UPYUN <operator>:<signature>:<DATE>` | 由 `endpoint` 决定（默认 `https://v0.api.upyun.com`） |

### 6.3 配置字段

| 适配器 | 必填字段 | 可选字段 |
|---|---|---|
| oss | `region` `bucket` `accessKeyId` `secretAccessKey` | `endpoint` `prefix` |
| cos | `region` `bucket` `appid` `accessKeyId` `secretAccessKey` | `endpoint` `prefix` |
| ks3 | `region` `bucket` `accessKeyId` `secretAccessKey` | `endpoint` `prefix` |
| obs | `region` `bucket` `accessKeyId` `secretAccessKey` | `endpoint` `prefix` |
| qiniu | `bucket` `accessKey` `secretKey` | `endpoint` `prefix` |
| upyun | `bucket` `operator` `password` | `endpoint` `prefix` |

- `endpoint` 可覆盖默认 Host（本地假服务 / 自建网关 / 自定义域名）；填写后走 path-style 挂在 endpoint 下。
- `region` 必填（COS 另需 `appid`）；保存时缺必填字段 → `400 invalid_input`，`details.field` 指明缺哪个。
- 密钥类字段只存服务端，列表 / 详情仅回显末四位掩码，永不下发明文。

### 6.4 配置示例（OSS，endpoint 指向本地假服务）

```json
{
  "name": "阿里云 OSS 备份",
  "type": "oss",
  "capacityBytes": 107374182400,
  "config": {
    "endpoint": "http://127.0.0.1:9101",
    "region": "oss-cn-hangzhou",
    "bucket": "r6t5-backup",
    "accessKeyId": "LTAIxxxxxxxxxxxx",
    "secretAccessKey": "xxxxxxxxxxxxxxxx",
    "prefix": "r6t5-drive"
  }
}
```

### 6.5 本地验证方式

`tools/fake-objstore.mjs` 是零依赖内存假服务：按厂商头前缀 / Authorization 方案推断类型，
校验 SigV4 三件套（Credential / SignedHeaders / 64 位 Signature）、时间戳格式与内容哈希头；
七牛校验 QBox 格式与 HMAC-SHA1 长度，又拍校验三段式与 MD5 十六进制。支持 PUT / GET / HEAD / DELETE 与 Range(206)。
验收脚本：`node tools/test-p9-d1.mjs`（自举隔离实例 + 假服务）。
