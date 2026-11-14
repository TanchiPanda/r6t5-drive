// 最小 aria2 JSON-RPC 假服务（纯内存，零依赖），仅用于 P5 自测。
// 支持：aria2.getVersion / addUri / tellStatus / tellActive / tellWaiting /
//       tellStopped / remove / removeDownloadResult。
// secret 校验：params[0] 必须等于 `token:<secret>`（配置了 secret 时）。
//
// 用法（脚本内）：
//   import { startFakeAria2 } from './fake-aria2.mjs';
//   const { port, close, calls, tasks } = await startFakeAria2({ port: 0, secret: 'testsecret' });
// CLI：node tools/fake-aria2.mjs --port 9101 --secret testsecret

import http from 'node:http';
import crypto from 'node:crypto';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createFakeAria2({ secret = '' } = {}) {
  const tasks = new Map(); // gid -> task
  const calls = []; // { method, args(脱敏), at }
  let gidSeq = 1;

  const nextGid = () => `aa${crypto.randomBytes(8).toString('hex')}${String(gidSeq++).padStart(4, '0')}`;

  function ok(id, result) {
    return { jsonrpc: '2.0', id, result };
  }
  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  function taskStatus(t) {
    return {
      gid: t.gid,
      status: t.status,
      totalLength: String(t.totalLength),
      completedLength: String(t.completedLength),
      downloadSpeed: t.status === 'active' ? 12345 : '0',
      errorCode: t.errorCode ?? '',
      errorMessage: t.errorMessage || '',
      files: t.files,
    };
  }

  function handle(method, params, id) {
    // secret 校验：首参为 token:***
    let args = Array.isArray(params) ? [...params] : [];
    if (secret) {
      if (args[0] !== `token:${secret}`) return rpcError(id, 1, 'Unauthorized');
      args = args.slice(1);
    }
    calls.push({ method, args, at: new Date().toISOString() });

    switch (method) {
      case 'aria2.getVersion':
        return ok(id, { version: '1.36.0-fake', features: ['Async DNS', 'BitTorrent', 'HTTP/FTP'] });

      case 'aria2.addUri': {
        const uris = Array.isArray(args[0]) ? args[0] : [];
        const options = args[1] && typeof args[1] === 'object' ? args[1] : {};
        if (!uris.length) return rpcError(id, 1, '缺少下载地址');
        const gid = nextGid();
        const fileName = String(uris[0].split('/').pop() || 'download.bin').split('?')[0];
        const dir = options.dir || '';
        const task = {
          gid,
          uris,
          options,
          status: 'active',
          totalLength: 1048576,
          completedLength: 0,
          errorCode: null,
          errorMessage: '',
          files: [{
            path: dir ? `${dir}/${fileName}` : fileName,
            length: '1048576',
            uris: uris.map((uri) => ({ uri, status: 'waiting' })),
          }],
          createdAt: new Date().toISOString(),
        };
        tasks.set(gid, task);
        return ok(id, gid);
      }

      case 'aria2.tellStatus': {
        const gid = args[0];
        const t = tasks.get(gid);
        if (!t) return rpcError(id, 1, `GID ${gid} not found`);
        return ok(id, taskStatus(t));
      }

      case 'aria2.tellActive':
        return ok(id, [...tasks.values()].filter((t) => t.status === 'active').map(taskStatus));

      case 'aria2.tellWaiting':
        return ok(id, [...tasks.values()].filter((t) => t.status === 'waiting').map(taskStatus));

      case 'aria2.tellStopped':
        return ok(id, [...tasks.values()].filter((t) => ['paused', 'removed', 'error', 'complete'].includes(t.status)).map(taskStatus));

      case 'aria2.remove': {
        const gid = args[0];
        const t = tasks.get(gid);
        if (!t) return rpcError(id, 1, `GID ${gid} not found`);
        t.status = 'removed';
        return ok(id, gid);
      }

      case 'aria2.removeDownloadResult': {
        const gid = args[0];
        if (!tasks.has(gid)) return rpcError(id, 1, `GID ${gid} not found`);
        tasks.delete(gid);
        return ok(id, gid);
      }

      default:
        return rpcError(id, -32601, `方法未实现：${method}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => '');
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { json = null; }

    if (!json || !json.method) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rpcError(null, -32700, '解析错误')));
    }
    const out = handle(json.method, json.params || [], json.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });

  return { server, tasks, calls };
}

export function startFakeAria2({ port = 0, secret = '' } = {}) {
  const { server, tasks, calls } = createFakeAria2({ secret });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        tasks,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// CLI：node tools/fake-aria2.mjs --port 9101 --secret testsecret
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv.indexOf('--port');
  const s = process.argv.indexOf('--secret');
  const { port, close } = await startFakeAria2({
    port: p >= 0 ? Number(process.argv[p + 1]) : 0,
    secret: s >= 0 ? process.argv[s + 1] : '',
  });
  console.log(`fake-aria2 listening on http://127.0.0.1:${port}/jsonrpc`);
  process.on('SIGINT', async () => { await close(); process.exit(0); });
}
