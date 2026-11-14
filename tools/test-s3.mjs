// S3 驱动自测：内联启动 fake-s3（随机端口），覆盖连通性、流式上传/下载、
// 列表（file/dir）、改名、删除、异常 bucket 自检。全通过 exit 0，任一失败 exit 1。
// 用法：node tools/test-s3.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFakeS3 } from './fake-s3.mjs';
import { s3Driver } from '../server/services/storage/s3.js';

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

const fake = await startFakeS3({ port: 0 });
const baseCfg = {
  endpoint: `http://127.0.0.1:${fake.port}`,
  region: 'us-east-1',
  bucket: 'test-bucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  prefix: 'r6t5-drive',
  pathStyle: 'on',
};
const strategy = { id: 's-test', type: 's3', config: JSON.stringify(baseCfg) };

// 真实 S3 桶需预先创建；假服务里预置一个空桶，使首次 HeadBucket 自检通过
fake.store['test-bucket'] = {};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6t5-s3-test-'));

try {
  // 1. test() 首次 → ok:true
  {
    const r = await s3Driver.test(strategy);
    check('1. test() 自检通过', r.ok === true, `ok=${r.ok} message=${r.message} bucket=${r.details?.bucket} latency=${r.details?.latencyMs}ms`);
  }

  // 2. 造 6MB 临时文件 → writeFromTemp 流式上传
  const bigPath = path.join(tmpDir, 'big.bin');
  const bigSize = 6 * 1024 * 1024;
  const source = Buffer.alloc(bigSize);
  // 填入伪随机可复现内容（避免全 0 压缩干扰长度比对）
  for (let i = 0; i < bigSize; i += 1024) {
    const block = crypto.randomBytes(Math.min(1024, bigSize - i));
    block.copy(source, i);
  }
  fs.writeFileSync(bigPath, source);
  const sourceSha = sha256Buf(source);
  {
    await s3Driver.writeFromTemp(strategy, 'alice@x.com/inbox/big.bin', bigPath, { size: bigSize, mime: 'application/octet-stream', name: 'big.bin' });
    const stored = fake.store['test-bucket']?.['r6t5-drive/alice@x.com/inbox/big.bin'];
    check('2. 6MB 流式上传成功', !!stored && stored.size === bigSize, `size=${stored?.size} expected=${bigSize}`);
  }

  // 3. readStream 读回，比对字节数与 sha256
  {
    const stream = await s3Driver.readStream(strategy, 'alice@x.com/inbox/big.bin');
    const buf = await streamToBuffer(stream);
    check('3. 下载字节数与 sha256 一致', buf.length === bigSize && sha256Buf(buf) === sourceSha,
      `bytes=${buf.length} sha=${sha256Buf(buf).slice(0, 12)}…`);
  }

  // 4. list('alice@x.com/inbox') → 1 个 file，remote:true，path 正确
  {
    const items = await s3Driver.list(strategy, 'alice@x.com/inbox');
    const f = items.find((i) => i.type === 'file' && i.name === 'big.bin');
    check('4. list 返回 file 条目', !!f && f.remote === true && f.path === 'alice@x.com/inbox/big.bin',
      `items=${items.map((i) => `${i.type}:${i.name}`).join(',')} path=${f?.path} remote=${f?.remote}`);
  }

  // 5. 写子目录对象 → list 出现 type:'dir' 的 sub
  {
    const subFile = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(subFile, 'hello 中文目录');
    await s3Driver.writeFromTemp(strategy, 'alice@x.com/inbox/sub/a.txt', subFile, { size: fs.statSync(subFile).size, mime: 'text/plain', name: 'a.txt' });
    const items = await s3Driver.list(strategy, 'alice@x.com/inbox');
    const d = items.find((i) => i.type === 'dir' && i.name === 'sub');
    check('5. list 识别出子目录 sub', !!d && d.remote === true && d.path === 'alice@x.com/inbox/sub',
      `items=${items.map((i) => `${i.type}:${i.name}`).join(',')} dirPath=${d?.path}`);
  }

  // 6. rename 后旧路径 404、新路径可读
  {
    await s3Driver.rename(strategy, 'alice@x.com/inbox/big.bin', 'alice@x.com/inbox/renamed.bin');
    let oldGone = false;
    try {
      await s3Driver.readStream(strategy, 'alice@x.com/inbox/big.bin');
    } catch (e) {
      oldGone = e.status === 404 || e.code === 'not_found';
    }
    const stream = await s3Driver.readStream(strategy, 'alice@x.com/inbox/renamed.bin');
    const buf = await streamToBuffer(stream);
    check('6. rename 后旧路径 404、新路径可读', oldGone && buf.length === bigSize && sha256Buf(buf) === sourceSha,
      `old404=${oldGone} newBytes=${buf.length}`);
  }

  // 7. remove 后 GET 404
  {
    await s3Driver.remove(strategy, 'alice@x.com/inbox/renamed.bin');
    let gone = false;
    try {
      await s3Driver.readStream(strategy, 'alice@x.com/inbox/renamed.bin');
    } catch (e) {
      gone = e.status === 404 || e.code === 'not_found';
    }
    check('7. remove 后 GET 404', gone, `404=${gone}`);
  }

  // 8. test() 指向不存在 bucket → ok:false，message 含 404/NoSuchBucket
  {
    const badStrategy = { id: 's-bad', type: 's3', config: JSON.stringify({ ...baseCfg, bucket: 'no-such-bucket' }) };
    const r = await s3Driver.test(badStrategy);
    const ok = r.ok === false && (/404|NoSuchBucket/.test(r.message));
    check('8. 不存在 bucket 自检 ok:false 且提示 404/NoSuchBucket', ok,
      `ok=${r.ok} message=${r.message} status=${r.details?.status}`);
  }

  // 9. fake-s3 关闭干净、无残留句柄
  {
    await fake.close();
    const listeners = fake.server?.listeners?.('close')?.length;
    check('9. close() 干净退出', true, `requests=${fake.requests.length} listeners=${listeners ?? 'n/a'}`);
  }
} catch (e) {
  check('测试流程未抛异常', false, `${e?.stack || e}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 兜底关闭，避免进程挂住
  try { await fake.close(); } catch { /* 已关闭 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
