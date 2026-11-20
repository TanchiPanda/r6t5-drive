# 第三方组件与许可声明

本仓库（`TanchiPanda/r6t5-drive`）自身的代码以根目录 [LICENSE](LICENSE)（MIT）授权。
本文件列出随项目分发、或由项目在运行时调用的第三方组件及其许可条件。**这些组件的许可不因本项目采用 MIT 而改变，各自条款优先。**

## 一、随代码分发的依赖

| 组件 | 用途 | 许可 | 义务 |
| --- | --- | --- | --- |
| Express | HTTP 服务 | MIT | 保留版权与许可声明 |
| multer | 上传解析 | MIT | 保留版权与许可声明 |
| better-sqlite3 | SQLite 驱动 | MIT | 保留版权与许可声明 |
| 其余传递依赖 | — | MIT / ISC / BSD-2 / BSD-3 / Apache-2.0 | 发布镜像时保留 `node_modules/*/LICENSE` |

前端为原生 HTML/CSS/JS，不含 React/Vue 等框架代码；`public/assets/icons/` 为项目自有素材，随本仓库授权。

## 二、计划接入的预览组件

按扩展分组逐个启用，启用前必须核对下表条款。**当前仓库已打包 pdf.js（`public/vendor/pdfjs/`）**，其余组件仍只是规划，尚未打包。

### 1. 可自托管、可随项目分发

| 组件 | 许可 | 使用要求 |
| --- | --- | --- |
| pdf.js（Mozilla） | Apache-2.0 | 已打包在 `public/vendor/pdfjs/`（含 `LICENSE`），未修改源码；升级时整包替换 |
| Monaco Editor（Microsoft） | MIT | 保留许可声明 |
| epub.js（futurepress） | BSD-2-Clause | 保留版权与许可全文 |
| Artplayer | MIT | 保留许可声明 |
| Excalidraw | MIT | 保留许可声明；不得以官方名义宣传 |
| zip 预览（自研或 MIT 库） | MIT / 自研 | 不使用 GPL 压缩库闭源分发 |

打包位置统一为 `public/vendor/<组件>/`，每个子目录保留原始 `LICENSE`，并在构建时随镜像一起分发。

### 2. 只能以官方服务形式嵌入（iframe）

| 服务 | 条款要点 | 红线 |
| --- | --- | --- |
| Photopea | 官方允许在任意网站免费 iframe 嵌入，带广告与其品牌；白标需成为 Distributor | 不得去广告、不得替换其 Logo/品牌、不得二次分发其代码 |
| draw.io / diagrams.net | 编辑器 Apache-2.0；名称与图标为 JGraph 商标 | 用官方 embed 模式；界面里不复制其彩色 Logo，文案可写「用 draw.io 打开」 |
| Google Docs Viewer | 无第三方嵌入专用条款，属灰色地带 | 默认关闭；由管理员在「设置 → 预览」显式开启；只传 10 分钟有效的随机签名 URL（不含邮箱、不含 Cookie），界面提示「文件 URL 将发送给 Google」 |
| Microsoft 365（Office for the web） | 官方支持 iframe 嵌入，前提是文档可被公开读取 | 同上：默认关闭、仅短期签名 URL、不含用户身份信息；离线/内网部署不提示启用 |

以上四个服务的共同约束：
- **默认关闭**，由管理员按扩展单独开启，并明确提示文件会离开本服务器；
- 只传短期签名 URL，不传长期令牌、不带用户 Cookie；
- 不在自己的品牌里使用对方的商标、Logo、配色作为产品标识。

### 3. 仅在服务端以独立进程调用

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| 7-Zip（`7z` CLI） | LGPL-2.1+，含 unRAR 限制 | 以子进程调用，不把其代码静态链入本仓库；分发镜像时保留许可文本；不得实现/逆向 RAR 压缩算法 |

## 三、与其它项目的关系

- 本项目**不含** Cloudreve 的代码、界面或文案；功能构成参考同类自托管网盘的通用做法，实现全部自研。
- 本项目不使用任何 GPL/AGPL 源码作为自身代码的一部分；如未来引入 copyleft 组件，将单独隔离目录并在本文件登记。

## 四、分发与商用注意

1. 发布镜像时保留 `LICENSES/` 或各依赖目录内的许可文件，不要用构建脚本剥掉。
2. 对外提供服务时，Photopea、Google、Microsoft 的嵌入页仍由对方渲染，其广告、登录与隐私政策不由本项目控制，需在用户协议中说明。
3. 本文件是工程层面的合规记录，不构成法律意见；商用发行前建议由法务复核。

---
最后更新：2026-11-18
