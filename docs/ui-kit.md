# R6T5 Drive · UI 规范（并行开发统一基线）

> 目标：4 条并行产线拼起来像一个人做的。所有页面必须只用 `assets/tokens.css` + `assets/base.css` 的类与变量，**不新增十六进制色值**，不改字体栈。

## 1. 引入顺序（每个页面固定）

```html
<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>页面名 · R6T5 Drive</title>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/base.css">
</head>
<body>
  <!-- 布局壳 -->
  <script src="/assets/api.js"></script>
  <script src="/assets/xxx.js"></script>
</body>
</html>
```

`data-theme` 由 `R6T5.theme.init()` 覆盖为本地存储值；页面内**不要**再写 `:root` 颜色。

## 2. 侧边栏导航文案（两侧共用，别自创叫法）

**用户侧**：文件（`/files`）、我的容量（`/account`）、分享（P2，禁用态）
**管理侧**：概览（`home.html`）、用户（`users.html`）、存储策略（`storage.html`）、用户组（`groups.html`）、分享（`shares.html`）、回收站（`trash.html`）、审计（`audit.html`）、站点设置（`settings.html`）

管理侧 nav-group 分组：`运行` → 概览 / 用户 / 存储策略 / 用户组；`治理` → 分享 / 回收站 / 审计；`系统` → 站点设置。

## 3. 页面骨架（照抄）

```html
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><span class="dot"></span><div>R6T5 Drive<small>管理控制台</small></div></div>
    <nav class="nav">
      <div class="nav-group">运行</div>
      <a href="/admin/home.html" class="active"><span class="ic">▤</span>概览</a>
      <!-- … -->
    </nav>
    <div class="side-foot">
      <div id="admin-identity" class="faint">未登录</div>
      <a href="/admin/login" class="faint">切换管理员</a>
    </div>
  </aside>
  <div>
    <div class="topbar">
      <div class="page-title small muted">概览</div>
      <div class="spacer"></div>
      <button class="btn icon ghost" id="theme-btn" type="button">☾</button>
      <a class="btn sm" href="/files" target="_blank" rel="noopener">打开前台</a>
    </div>
    <main class="main"><div class="content">
      <div class="page-head">
        <div><h1>概览</h1><p class="sub">站点运行状态</p></div>
        <div class="actions"><button class="btn" type="button">刷新</button></div>
      </div>
      <!-- 内容 -->
    </div></main>
  </div>
  <div class="toasts"></div>
</div>
```

用户侧同理，`sidebar` 里品牌副标题写 `个人空间`，第一屏不出现管理入口（普通用户看不到 admin）。

## 4. 常用组合

| 场景 | 结构 |
|---|---|
| 指标卡 | `<div class="stat"><div class="k">用户总数</div><div class="v">12</div><div class="d">今日 +2</div></div>` |
| 列表容器 | `<div class="card"><div class="card-head"><h3>标题</h3><span class="hint">说明</span><div class="actions">…</div></div><div class="table-wrap"><table class="table">…</table></div></div>` |
| 空态 | `<div class="empty"><div class="ico">▢</div><h3>还没有存储策略</h3><p>…</p><div class="actions"><button class="btn primary">添加策略</button></div></div>` |
| 表单字段 | `<div class="field"><label>策略名</label><input class="input" name="name"><span class="help">…</span><span class="err"></span></div>` |
| 状态 | `<span class="badge ok"><span class="dot-s"></span>正常</span>` |
| 用量条 | `<div class="bar"><i style="width:42%"></i></div>` |
| 弹窗 | `<div class="modal-mask" id="m-x"><div class="modal">…</div></modal-mask>` + `R6T5.modal.bind('#m-x')` |
| 提示 | `R6T5.toast('已保存','ok')` / `.toastError(e)` |

## 5. 文案与合规

- 全站中文，术语统一：**存储策略**（不叫「存储后端/驱动」）、**用户组**（不叫「权限组」）、**回收站**、**空间上限**、**单文件上限**、**7 天上传流量**。
- 不得出现任何第三方网盘产品的品牌名、Logo、文案或近似命名（本项目全部文案与 UI 均为自研）；图标一律用 Unicode 符号或纯 CSS 绘制，**不引入任何第三方图标库**。
- 数字一律带单位（`R6T5.fmtBytes`），时间用 `R6T5.fmtAgo/fmtTime`。

## 6. 图表（不许引第三方库）

概览页趋势图用 `<canvas>` 手绘折线/柱状，颜色只能取 `getComputedStyle(document.documentElement).getPropertyValue('--acc')` 等变量，保证换主题时重绘。
分布图可用纯 CSS（`conic-gradient` 环形 + 图例），宽度按占比算。
