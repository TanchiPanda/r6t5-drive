// 自研 Markdown → 安全 HTML（零 npm 依赖，仅 node 内建）。
// 安全模型（见 docs 预览约定 / P3 任务书）：
//   1. 整段原文先做 HTML 转义（& < > " '），原始 HTML 一律以文本呈现；
//   2. 只识别白名单语法：标题、粗体、斜体、行内代码、围栏代码块、有序/无序列表、
//      引用、链接（url 仅允许 http/https/mailto，其它协议一律丢弃为纯文本）；
//   3. 输出里不允许出现 <script>、on*= 属性、javascript: 协议、<iframe>、原始 HTML 透传；
//   4. 围栏代码块内的文本再次转义（即使内容含被转义过的实体也不会被二次解析为标签）。
//
// 注意：本模块不做服务端重编码，也不解析图片/HTML 标签；表格为可选增强，仅识别
// 标准分隔行（--- / :---），单元格内容同样经过转义与行内白名单处理。

const CODE_BLOCK_LANG = /^[a-zA-Z0-9_+\-#.]*$/;

/** 最小 HTML 转义：& < > " ' */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/**
 * 危险 token 钝化：即使原始 HTML 已被转义为惰性文本，也不残留可被搜索/二次解析的
 * `javascript:` 协议串与 `on*=` 事件属性写法。作用在「已经转义过」的文本之上。
 */
function neutralizeDanger(escaped) {
  return escaped
    .replace(/javascript:/gi, 'javascript&#58;')
    .replace(/\son([a-z]+)\s*=/gi, ' on$1&#61;')
    .replace(/^on([a-z]+)\s*=/gi, 'on$1&#61;');
}

/** 白名单协议：http / https / mailto。其余（javascript:、data:、file: 等）一律拒绝。 */
function safeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  // 去掉首尾空白与控制字符
  const clean = raw.replace(/[\u0000-\u0020]+/g, '');
  if (!clean) return null;
  const lower = clean.toLowerCase();
  const allowed = ['http://', 'https://', 'mailto:'];
  if (allowed.some((p) => lower.startsWith(p))) return clean;
  return null;
}

/**
 * 行内语法：链接 `[text](url)`、粗体 `**x**`、斜体 `*x*`、行内代码 `` `x` ``。
 * 入参必须是「已经整体转义过」的文本；本函数只在转义结果之上插入白名单标签。
 */
function renderInline(escaped) {
  let out = neutralizeDanger(escaped);

  // 1) 行内代码：先抽出，避免其中的 * _ [ ] 被后面规则二次解析
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });

  // 2) 链接 [text](url)：text 已转义；url 走白名单，非法则退化为纯文本（保留可见文字）
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*)?\)/g, (whole, text, url) => {
    const u = safeUrl(url);
    if (!u) return text; // 非法协议 → 丢弃链接，只保留文字
    return `<a href="${escapeHtml(u)}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`;
  });

  // 3) 粗体 **x**（优先于斜体，避免 ** 被拆成两个 *）
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 4) 斜体 *x* / _x_
  out = out.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
  out = out.replace(/(^|[\s(])_([^_\s][^_]*)_([\s)]|$)/g, '$1<em>$2</em>$3');

  // 5) 回填行内代码（代码内容在进入本函数前已被整体转义，这里只包 <code>）
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);

  return out;
}

/** 表格分隔行：|---|:--:|--:| */
function isTableDelimiter(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * 渲染完整 Markdown 文本为安全 HTML。
 * @param {string} markdown 原始 Markdown（可能含恶意 HTML / 脚本）
 * @returns {string} 安全 HTML 片段
 */
export function renderMarkdown(markdown) {
  const source = String(markdown == null ? '' : markdown);
  const lines = source.split(/\r\n|\r|\n/);
  const html = [];
  let i = 0;

  let listType = null; // 'ul' | 'ol'，用于合并连续列表项
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块 ```lang 或 ~~~lang
    const fence = line.match(/^\s*(```|~~~)\s*([a-zA-Z0-9_+\-#.]*)\s*$/);
    if (fence) {
      flushPara();
      closeList();
      const marker = fence[1];
      const lang = CODE_BLOCK_LANG.test(fence[2]) ? fence[2] : '';
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      // 代码块内容整体再转义一次（入参此时为原始文本，未经过外层转义），并钝化危险 token
      const code = neutralizeDanger(escapeHtml(buf.join('\n')));
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre><code${langAttr}>${code}</code></pre>`);
      i += 1; // 跳过收尾围栏
      continue;
    }

    // 表格：表头行 + 紧随分隔行
    if (isTableDelimiter(lines[i + 1] || '') && /\|/.test(line)) {
      flushPara();
      closeList();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const th = header.map((c) => `<th>${renderInline(escapeHtml(c))}</th>`).join('');
      const trs = rows.map((r) =>
        `<tr>${r.map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join('')}</tr>`).join('');
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // 标题 # .. ######
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用 > （连续引用行合并）
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${renderInline(escapeHtml(buf.join(' ')))}</blockquote>`);
      continue;
    }

    // 无序列表 - / * / +
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`);
      i += 1;
      continue;
    }

    // 有序列表 1. / 1)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push(`<li>${renderInline(escapeHtml(ol[1]))}</li>`);
      i += 1;
      continue;
    }

    // 空行：段落 / 列表边界
    if (line.trim() === '') {
      flushPara();
      closeList();
      i += 1;
      continue;
    }

    // 普通段落行（连续非空非特殊行合并为一段）
    para.push(line.trim());
    i += 1;
  }

  flushPara();
  closeList();
  return html.join('\n');
}

/**
 * 输出前的安全兜底断言：渲染结果绝不能包含以下任何内容。
 * 仅用于测试 / 内部自检；命中即抛错（防御纵深：白名单遗漏时显式失败而非泄露）。
 */
export function assertSafeHtml(html) {
  const lowered = String(html).toLowerCase();
  const forbidden = [
    ['<script', '<script> 标签'],
    ['<iframe', '<iframe> 标签'],
    ['<object', '<object> 标签'],
    ['<embed', '<embed> 标签'],
    ['javascript:', 'javascript: 协议'],
    ['onerror=', 'on*= 事件属性'],
    ['onload=', 'on*= 事件属性'],
    ['onclick=', 'on*= 事件属性'],
    ['onmouseover=', 'on*= 事件属性'],
  ];
  for (const [needle, label] of forbidden) {
    if (lowered.includes(needle)) {
      throw new Error(`Markdown 渲染结果检出非法内容：${label}`);
    }
  }
  // on*= 通用扫描（避免漏掉 onfocus 等）
  if (/\son[a-z]+\s*=/i.test(String(html))) {
    throw new Error('Markdown 渲染结果检出 on*= 事件属性');
  }
  return true;
}
