// P8-B 本地假 SMTP 服务器（零依赖）：供 test-p8-security.mjs 注入发信链路。
//  - SMTP 端口 2525：EHLO / AUTH PLAIN / MAIL FROM / RCPT TO / DATA / QUIT
//  - HTTP 端口 2526：GET /messages 返回内存中收到的邮件（JSON），GET /healthz
// 用法：node tools/fake-smtp.mjs  （可用环境变量 SMTP_PORT / HTTP_PORT 覆盖）
import net from 'node:net';
import http from 'node:http';

const SMTP_PORT = Number(process.env.SMTP_PORT || 2525);
const HTTP_PORT = Number(process.env.HTTP_PORT || 2526);

const messages = [];

function decodeB64(block) {
  try { return Buffer.from(block.replace(/\s/g, ''), 'base64').toString('utf8'); }
  catch { return block; }
}

function parseBody(headers, body) {
  const ct = headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=("?)([^";]+)\1/);
  if (!boundaryMatch) {
    return headers['content-transfer-encoding'] === 'base64' ? decodeB64(body) : body;
  }
  const boundary = boundaryMatch[2];
  const parts = body.split(`--${boundary}`);
  const decoded = [];
  for (const part of parts) {
    const blank = part.indexOf('\r\n\r\n');
    if (blank < 0) continue;
    const head = part.slice(0, blank);
    const block = part.slice(blank + 4);
    const enc = /content-transfer-encoding:\s*base64/i.test(head);
    decoded.push(enc ? decodeB64(block) : block);
  }
  return decoded.join('\n');
}

function parseMessage(raw, to) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  let headers = {};
  let body = raw;
  if (headerEnd >= 0) {
    const head = raw.slice(0, headerEnd);
    body = raw.slice(headerEnd + 4);
    for (const line of head.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return {
    to,
    subject: headers.subject || '',
    from: headers.from || '',
    replyTo: headers['reply-to'] || '',
    raw,
    body,
    decoded: parseBody(headers, body),
    receivedAt: new Date().toISOString(),
  };
}

const smtp = net.createServer((socket) => {
  let buffer = '';
  let mailFrom = null;
  const rcptTo = [];
  let dataMode = false;
  let dataBuffer = '';

  socket.write('220 fake-smtp ready\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);

      if (dataMode) {
        if (line === '.') {
          dataMode = false;
          messages.push(parseMessage(dataBuffer, rcptTo));
          socket.write('250 OK queued\r\n');
          dataBuffer = '';
        } else {
          dataBuffer += line + '\r\n';
        }
        continue;
      }

      const upper = line.toUpperCase();
      if (process.env.FAKE_SMTP_DEBUG) console.log(`[fake-smtp] C: ${line}`);
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-fake-smtp greets\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
      } else if (upper === 'STARTTLS') {
        socket.write('500 STARTTLS not supported by fake server\r\n');
      } else if (upper.startsWith('AUTH PLAIN')) {
        socket.write('235 Authentication successful\r\n');
      } else if (upper.startsWith('AUTH LOGIN')) {
        socket.write('334 VXNlcm5hbWU6\r\n');
      } else if (/^[A-Za-z0-9+/=]+$/.test(line) && rcptTo.length === 0 && mailFrom === null) {
        // AUTH LOGIN 用户名/密码应答，直接放行
        socket.write('235 Authentication successful\r\n');
      } else if (upper.startsWith('MAIL FROM:')) {
        mailFrom = line.slice(10).trim();
        socket.write('250 OK\r\n');
      } else if (upper.startsWith('RCPT TO:')) {
        rcptTo.push(line.slice(8).trim());
        socket.write('250 OK\r\n');
      } else if (upper === 'DATA') {
        dataMode = true;
        dataBuffer = '';
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (upper === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
      } else if (line.trim() === '') {
        // 空行忽略
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });

  socket.on('error', () => socket.destroy());
  socket.on('close', () => socket.destroy());
});

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, messages: messages.length }));
  }
  if (req.url === '/messages') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: messages.length, messages }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

smtp.listen(SMTP_PORT, '127.0.0.1', () => console.log(`[fake-smtp] SMTP 127.0.0.1:${SMTP_PORT}`));
httpServer.listen(HTTP_PORT, '127.0.0.1', () => console.log(`[fake-smtp] HTTP 127.0.0.1:${HTTP_PORT}`));

// 供被测试进程通过子进程方式取消息时导出
export { messages };
