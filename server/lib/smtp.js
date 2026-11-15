// P8-B 零依赖最小 SMTP 客户端（node:net / node:tls）。
// 支持：欢迎码读取、EHLO、STARTTLS 升级后重发 EHLO、AUTH PLAIN/LOGIN、
// 多收件人、DATA（dot-stuffing）、多行响应（250- 续行）、超时与错误码上报。
//
// TLS 判定：
//  - config.secure=true  ── 直连 TLS（隐式 TLS，常见 465）；
//  - config.secure=false ── 明文连接先 EHLO：服务端 EHLO 含 STARTTLS 且端口非 465
//    则升级 TLS；不支持 STARTTLS 且端口非 465 时保持明文（有风险，见 api-contract §P8-2）。
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

function asciiPrintable(s) {
  return /^[\x20-\x7E]*$/.test(s);
}

/** RFC2047 单词编码：非 ASCII 整体 base64 编码。 */
export function encodeWord(text) {
  const s = String(text ?? '');
  if (asciiPrintable(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function encodeSubject(subject) {
  const s = String(subject ?? '');
  if (asciiPrintable(s)) return s;
  return encodeWord(s);
}

function encodeHeaderAddress(name, address) {
  if (name && name.trim()) return `${encodeWord(name.trim())} <${address}>`;
  return `<${address}>`;
}

function base64Lines(buf) {
  const b64 = buf.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

/** dot-stuffing：行首 '.' 前置一个 '.'；正文按 CRLF 分行。 */
function dotStuff(body) {
  return String(body)
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

function buildMessage({ to, subject, text, html, fromName, fromEmail, replyTo }) {
  const headers = [
    `From: ${encodeHeaderAddress(fromName, fromEmail)}`,
    `To: <${Array.isArray(to) ? to.join('>, <') : to}>`,
  ];
  if (replyTo) headers.push(`Reply-To: <${replyTo}>`);
  headers.push(`Subject: ${encodeSubject(subject)}`);
  headers.push('MIME-Version: 1.0');

  const textBody = text != null ? String(text) : '';
  const htmlBody = html != null ? String(html) : '';

  let body;
  if (textBody && htmlBody) {
    const boundary = `r6t5_${cryptoRandom(16)}`;
    headers.push('Content-Type: multipart/alternative; boundary=' + boundary);
    const partText = [
      `Content-Type: text/plain; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(textBody, 'utf8')),
    ].join(CRLF);
    const partHtml = [
      `Content-Type: text/html; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(htmlBody, 'utf8')),
    ].join(CRLF);
    body = `--${boundary}${CRLF}${partText}${CRLF}--${boundary}${CRLF}${partHtml}${CRLF}--${boundary}--${CRLF}`;
  } else if (htmlBody) {
    headers.push('Content-Type: text/html; charset=utf-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = base64Lines(Buffer.from(htmlBody, 'utf8'));
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = base64Lines(Buffer.from(textBody, 'utf8'));
  }

  return headers.join(CRLF) + CRLF + CRLF + body;
}

function cryptoRandom(len) {
  const { randomBytes } = globalThis.crypto || {};
  if (randomBytes) return randomBytes(len).toString('hex');
  return Array.from({ length: len }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

class SmtpSession {
  constructor(config) {
    this.config = config;
    this.sock = null;
    this.buf = '';
    this.caps = new Set();
    this.closed = false;
  }

  connect() {
    const { host, port, secure, connTimeoutMs } = this.config;
    return new Promise((resolve, reject) => {
      const opts = { host, port, servername: host, timeout: connTimeoutMs };
      const sock = secure ? tls.connect(opts) : net.connect(opts);
      this.sock = sock;
      sock.setTimeout(connTimeoutMs);
      const onTimeout = () => { this.fail(new Error('SMTP 连接超时')); };
      const onError = (err) => { if (!this.closed) reject(err); };
      sock.once('timeout', onTimeout);
      sock.once('error', onError);
      sock.on('connect', () => { sock.removeListener('timeout', onTimeout); resolve(); });
      sock.on('secureConnect', () => { sock.removeListener('timeout', onTimeout); resolve(); });
      this._reject = reject;
    });
  }

  fail(err) {
    this.closed = true;
    try { this.sock?.destroy(); } catch { /* noop */ }
    throw err;
  }

  readLines() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('SMTP 响应读取超时'));
      }, this.config.connTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.sock.removeListener('data', onData);
        this.sock.removeListener('error', onError);
      };
      const onError = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
      const check = () => {
        const lines = [];
        // 持续抽取完整行，直到遇到以「code 空格」结尾的最终行
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const nl = this.buf.indexOf(CRLF);
          if (nl < 0) return; // 等待更多数据
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 2);
          lines.push(line);
          const final = line.length >= 4 && line[3] === ' ';
          const cont = line.length >= 4 && line[3] === '-';
          if (!final && !cont) { lines[lines.length - 1] = line; }
          if (final || !cont) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ code: line.slice(0, 3), lines });
            return;
          }
        }
      };
      const onData = (chunk) => { this.buf += chunk.toString('utf8'); check(); };
      this.sock.on('data', onData);
      this.sock.once('error', onError);
    });
  }

  send(line) {
    this.sock.write(line + CRLF);
  }

  async command(cmd, expectCodes) {
    if (cmd != null) this.send(cmd);
    const { code, lines } = await this.readLines();
    if (!expectCodes.includes(code)) {
      const err = new Error(`SMTP 命令「${cmd}」被拒：${code} ${lines.join(' / ')}`);
      err.smtpCode = code;
      err.response = lines.join(' / ');
      throw err;
    }
    return { code, lines };
  }

  parseCaps(lines) {
    for (const line of lines) {
      if (/^\d{3}[ -]/.test(line)) {
        const rest = line.slice(4).trim();
        rest.split(/\s+/).forEach((tok) => this.caps.add(tok.toUpperCase()));
      }
    }
  }

  async ehlo() {
    const host = this.config.host || 'localhost';
    const { lines } = await this.command(`EHLO ${host}`, ['250']);
    this.parseCaps(lines);
  }

  async maybeStartTls() {
    const { host, port, secure } = this.config;
    if (secure) return;
    if (port === 465) return; // 465 本应走隐式 TLS；明文模式下不升级
    if (!this.caps.has('STARTTLS')) return; // 服务端不支持：保持明文（风险见文档）
    let tlsReady = false;
    try {
      await this.command('STARTTLS', ['220']);
      tlsReady = true;
    } catch (err) {
      // 服务端未真正支持 STARTTLS（非 220）：按 spec 回落明文，继续发信（风险见文档）。
      console.warn(`[smtp] STARTTLS 不可用，回落明文：${err.response || err.message}`);
    }
    if (!tlsReady) return;
    const tlsSock = tls.connect({ socket: this.sock, servername: host });
    await new Promise((resolve, reject) => {
      tlsSock.once('secureConnect', resolve);
      tlsSock.once('error', reject);
    });
    this.sock = tlsSock;
    this.buf = '';
    await this.ehlo(); // 升级后必须重发 EHLO 重新协商能力
  }

  async auth() {
    const { username, password } = this.config;
    if (!username) return;
    const mechs = [...this.caps].filter((c) => c.startsWith('AUTH'));
    const supports = (m) => mechs.some((c) => c.split(/\s+/).includes(m));

    if (supports('PLAIN')) {
      const initial = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
      await this.command(`AUTH PLAIN ${initial}`, ['235']);
      return;
    }
    if (supports('LOGIN')) {
      await this.command('AUTH LOGIN', ['334']);
      await this.command(Buffer.from(username, 'utf8').toString('base64'), ['334']);
      await this.command(Buffer.from(password, 'utf8').toString('base64'), ['235']);
      return;
    }
    const err = new Error('SMTP 服务端不支持 PLAIN/LOGIN 认证');
    err.smtpCode = '504';
    throw err;
  }

  async deliver({ to, subject, text, html }) {
    const cfg = this.config;
    const recipients = Array.isArray(to) ? to : [to];

    await this.command(`MAIL FROM:<${cfg.fromEmail}>`, ['250']);
    for (const rcpt of recipients) {
      await this.command(`RCPT TO:<${rcpt}>`, ['250', '251', '252']);
    }
    await this.command('DATA', ['354']);
    const message = buildMessage({
      to: recipients, subject, text, html,
      fromName: cfg.fromName, fromEmail: cfg.fromEmail, replyTo: cfg.replyTo,
    });
    this.sock.write(dotStuff(message) + CRLF);
    const { code, lines } = await this.command('.', ['250']);
    return { code, response: lines.join(' / ') };
  }

  async quit() {
    try { this.send('QUIT'); } catch { /* noop */ }
    this.closed = true;
    try { this.sock?.destroy(); } catch { /* noop */ }
  }
}

/**
 * 发送一封邮件。
 * @param {object} config smtpConfig() 结果
 * @param {{to:string|string[], subject:string, text?:string, html?:string}} mail
 * @returns {Promise<{ok:boolean, code:string, response:string}>}
 */
export async function sendMail(config, mail) {
  const session = new SmtpSession(config);
  try {
    await session.connect();
    await session.command(null, ['220']); // 欢迎码
    await session.ehlo();
    await session.maybeStartTls();
    await session.auth();
    const result = await session.deliver(mail);
    await session.quit();
    return { ok: true, code: result.code, response: result.response };
  } catch (err) {
    try { await session.quit(); } catch { /* noop */ }
    return {
      ok: false,
      code: err.smtpCode || 'conn_error',
      response: err.message || String(err),
    };
  }
}
