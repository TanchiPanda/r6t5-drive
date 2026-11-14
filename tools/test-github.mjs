// GitHub 只读驱动可复跑验证脚本（零 npm 依赖）。
// 用法：
//   node tools/test-github.mjs                 # 匿名访问
//   GITHUB_TOKEN=xxx node tools/test-github.mjs # 带令牌（私有/限流场景）
// token 只从 process.env 读取，绝不落盘、不打印。
import { githubDriver } from '../server/services/storage/github.js';

const token = typeof process.env.GITHUB_TOKEN === 'string' ? process.env.GITHUB_TOKEN.trim() : '';

const PUBLIC_STRATEGY = {
  id: 'test-public',
  type: 'github',
  config: { repo: 'octocat/Hello-World', branch: 'master', rootPath: '', token },
};

const MISSING_REPO_STRATEGY = {
  id: 'test-missing',
  type: 'github',
  config: { repo: 'owner/definitely-not-exist-xyz', branch: 'main', rootPath: '', token },
};

const results = [];

function record(name, status, reason) {
  results.push({ name, status, reason });
  console.log(`${status} | ${name} | ${reason}`);
}

// 判断上游错误是否属于「匿名被限流」（403 且 X-RateLimit-Remaining: 0 / 429）。
// 沙箱出口 IP 匿名请求已触发限流；命中则把联网用例标记 SKIP，不伪装 PASS。
function isAnonymousRateLimit(err) {
  if (!err) return false;
  const status = err.details?.status;
  return status === 429 || (status === 403 && /限流/.test(err.message || ''));
}

function looksRateLimited(obj) {
  if (obj && obj.ok === false && /限流/.test(obj.message || '')) return true;
  return false;
}

// 把流读完，逐块收集字节；同时验证返回的是流（不是一次性 buffer）。
async function consumeStream(stream) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error('readStream 返回的不是流（缺少 getReader）');
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value ? value.length : 0;
  }
  return { total, chunks };
}

// ── 用例 1：只读拒绝（纯内存，不联网）─────────────────────────────────────
function testReadOnly() {
  const ops = [
    ['writeFromTemp', () => githubDriver.writeFromTemp(PUBLIC_STRATEGY, 'alice@x.com/inbox/a.md', '/tmp/x', { size: 1, mime: 'text/plain', name: 'a.md' })],
    ['remove', () => githubDriver.remove(PUBLIC_STRATEGY, 'alice@x.com/inbox/a.md', {})],
    ['rename', () => githubDriver.rename(PUBLIC_STRATEGY, 'alice@x.com/inbox/a.md', 'alice@x.com/inbox/b.md', {})],
  ];
  const failures = [];
  for (const [op, fn] of ops) {
    try {
      fn();
      failures.push(`${op} 未抛错`);
    } catch (err) {
      if (err.code !== 'strategy_readonly' || err.status !== 403) {
        failures.push(`${op} 抛出 code=${err.code} status=${err.status}（应为 strategy_readonly/403）`);
      }
    }
  }
  if (failures.length === 0) {
    record('1. 只读写操作拒绝', 'PASS', 'writeFromTemp/remove/rename 均抛 strategy_readonly (403)');
  } else {
    record('1. 只读写操作拒绝', 'FAIL', failures.join('；'));
  }
}

// ── 用例 2：公开仓库只读列举（联网）───────────────────────────────────────
async function testList() {
  let entries;
  try {
    entries = await githubDriver.list(PUBLIC_STRATEGY, '');
  } catch (err) {
    if (isAnonymousRateLimit(err)) {
      record('2. 公开仓库只读列举', 'SKIP', `未验证：GitHub API 匿名限流（${err.message}）`);
      return { skipped: true };
    }
    record('2. 公开仓库只读列举', 'FAIL', `列举抛错：code=${err.code} status=${err.details?.status} ${err.message}`);
    return { skipped: true };
  }
  const ok = Array.isArray(entries) && entries.length >= 1 && entries.every((e) => e.remote === true);
  if (ok) {
    const kinds = entries.map((e) => e.type).join(',');
    record('2. 公开仓库只读列举', 'PASS', `拿到 ${entries.length} 条（${kinds}），remote=true；样例：${entries[0].name}`);
  } else {
    record('2. 公开仓库只读列举', 'FAIL', `条目数=${Array.isArray(entries) ? entries.length : '非数组'}`);
  }
  return { entries };
}

// ── 用例 3：流式下载（联网，依赖用例 2 结果）──────────────────────────────
async function testDownload(entries) {
  if (!Array.isArray(entries)) {
    record('3. 流式下载文件', 'SKIP', '未验证：列举未成功，无文件可下载（GitHub API 匿名限流）');
    return;
  }
  if (entries.length === 0) return;
  const file = entries.find((e) => e.type === 'file') || entries[0];
  let stream;
  try {
    stream = await githubDriver.readStream(PUBLIC_STRATEGY, file.path, {});
  } catch (err) {
    if (isAnonymousRateLimit(err)) {
      record('3. 流式下载文件', 'SKIP', `未验证：GitHub API 匿名限流（${err.message}）`);
      return;
    }
    record('3. 流式下载文件', 'FAIL', `readStream 抛错：status=${err.details?.status} ${err.message}`);
    return;
  }
  let bytes;
  try {
    bytes = await consumeStream(stream);
  } catch (err) {
    record('3. 流式下载文件', 'FAIL', `流消费失败：${err.message}`);
    return;
  }
  if (bytes.total > 0) {
    record('3. 流式下载文件', 'PASS', `文件 ${file.path} 流式读取 ${bytes.total} 字节，分块 ${bytes.chunks.length} 块`);
  } else {
    record('3. 流式下载文件', 'FAIL', `文件 ${file.path} 读到 0 字节`);
  }
}

// ── 用例 4：test() 对不存在仓库 → ok:false 且含 404 ──────────────────────
async function testMissingRepo() {
  let result;
  try {
    result = await githubDriver.test(MISSING_REPO_STRATEGY);
  } catch (err) {
    record('4. 不存在仓库自检', 'FAIL', `test() 不应抛错，但抛出：status=${err.details?.status} ${err.message}`);
    return;
  }
  if (looksRateLimited(result)) {
    record('4. 不存在仓库自检', 'SKIP', `未验证：GitHub API 匿名限流（${result.message}）`);
    return;
  }
  const ok = result.ok === false && /404/.test(result.message || '');
  if (ok) {
    record('4. 不存在仓库自检', 'PASS', `ok=false，message="${result.message}"，details=${JSON.stringify(result.details)}`);
  } else {
    record('4. 不存在仓库自检', 'FAIL', `ok=${result.ok} message="${result.message}"（应含 404）`);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
console.log(`GitHub 驱动验证 | token=${token ? '已提供（长度 ' + token.length + '，已隐藏）' : '未提供（匿名）'}`);
console.log(`策略：repo=${PUBLIC_STRATEGY.config.repo} branch=${PUBLIC_STRATEGY.config.branch}`);

testReadOnly();

const { entries } = await testList();
await testDownload(entries);
await testMissingRepo();

const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const passed = results.filter((r) => r.status === 'PASS').length;
console.log(`\n汇总：PASS=${passed} FAIL=${failed} SKIP=${skipped}`);

// 有 FAIL 才非零退出；SKIP（匿名限流）不视为失败，exit 0。
process.exit(failed > 0 ? 1 : 0);
