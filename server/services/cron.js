// P9-C 内置 Cron 调度器（单进程内存态）。
// - 每分钟 tick 一次；支持 `@every <n><m|h>` 与标准 5 段 cron（分 时 日 月 周）。
// - 下次执行时间只在内存计算，不持久化；进程重启后以启动时刻为基准重新排程。
// - 两个任务：notify（到期前提醒）、ban（过期降级 / 加成过期清理 / 超额缓冲判定）。
// - 任何 Cron 路径都不会把订单置为 paid。
import { db, getSetting } from '../db.js';
import { nowIso } from '../lib/format.js';
import { getDefaultGroup, getGroupById, usedBytes, grantBytes } from './quota.js';
import { billingConfig } from './billing-config.js';
import { writeAudit } from './audit.js';

const TICK_MS = 60 * 1000;

const state = {
  timer: null,
  started: false,
  jobs: {
    notify: { expr: null, nextRunAt: null, lastRunAt: null, lastOk: null, lastResult: null, lastError: null },
    ban: { expr: null, nextRunAt: null, lastRunAt: null, lastOk: null, lastResult: null, lastError: null },
  },
};

// ---------- 表达式解析 ----------

function parseEvery(expr) {
  const m = /^@every\s+(\d+)\s*(m|min|mins|h|hour|hours)$/i.exec(String(expr || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase().startsWith('h') ? 3600_000 : 60_000;
  return { kind: 'every', intervalMs: n * unit };
}

function fieldMatches(field, value) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const stepM = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    if (stepM) {
      const step = Number(stepM[2]);
      let lo = 0, hi = 59;
      if (stepM[1] !== '*') {
        const range = stepM[1].split('-');
        lo = Number(range[0]);
        hi = range[1] != null ? Number(range[1]) : lo;
      }
      return value >= lo && value <= hi && (value - lo) % step === 0;
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else if (Number(part) === value) return true;
  }
  return false;
}

function cronMatches(date, expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;
  return (
    fieldMatches(min, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(month, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

/** 计算 after 之后下一次执行时间；找不到返回 null。 */
function nextRunAt(expr, after) {
  const every = parseEvery(expr);
  if (every) return new Date(after.getTime() + every.intervalMs);
  // 5 段 cron：逐分钟向后找（上限 366 天）
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = after.getTime() + 366 * 24 * 3600_000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(cursor, expr)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ---------- 任务实现 ----------

function defaultGroupId() {
  const sid = getSetting('defaultGroupId', null);
  if (sid) {
    const g = getGroupById(sid);
    if (g) return g.id;
  }
  const def = getDefaultGroup();
  return def ? def.id : null;
}

/** 过期会员降级回默认组；清理/统计过期容量加成；超额缓冲期判定（本批不硬拦）。 */
function runBan() {
  const now = new Date();
  const nowIsoStr = now.toISOString();
  const defId = defaultGroupId();
  const cfg = billingConfig();

  const expiredUsers = db.prepare(
    "SELECT * FROM users WHERE groupExpiresAt IS NOT NULL AND groupExpiresAt <= ?"
  ).all(nowIsoStr);

  const revertStmt = db.prepare('UPDATE users SET groupId = ?, groupExpiresAt = NULL WHERE id = ?');
  for (const u of expiredUsers) {
    revertStmt.run(defId, u.id);
    writeAudit({ email: u.email, action: 'group_expired', target: u.groupId, detail: `revert_to:${defId}` });
  }

  // 过期容量加成：配额计算已自动排除；这里统计数量并清理超过 30 天的过期行。
  const expiredGrants = db.prepare(
    'SELECT COUNT(*) AS n FROM storage_grants WHERE expiresAt IS NOT NULL AND expiresAt <= ?'
  ).get(nowIsoStr).n;
  const cleanupBefore = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const pruned = db.prepare(
    'DELETE FROM storage_grants WHERE expiresAt IS NOT NULL AND expiresAt <= ?'
  ).run(cleanupBefore).changes;

  // 超额缓冲期判定：降级/包到期后仍超配额的用户（仅统计与提示，不在本批硬拦上传）。
  const overGrace = [];
  const graceBytes = 0n; // 缓冲期只做提示，不放宽限额；预留口径
  void graceBytes;
  const users = db.prepare('SELECT * FROM users').all();
  for (const u of users) {
    const used = usedBytes(u.email);
    const limit = usedLimit(u.email);
    if (used > limit) overGrace.push({ email: u.email, used: used.toString(), limit: limit.toString() });
  }

  return {
    expiredMembers: expiredUsers.length,
    expiredGrants: Number(expiredGrants),
    prunedGrants: Number(pruned),
    overQuotaUsers: overGrace.length,
    overQuotaSample: overGrace.slice(0, 10),
    graceDays: cfg.overQuotaGraceDays,
  };
}

function usedLimit(email) {
  // 与 quotaForUser 同口径：组配额 + 未过期加成（BigInt）
  const group = getGroupById(db.prepare('SELECT groupId FROM users WHERE email = ?').get(email)?.groupId) || getDefaultGroup();
  const base = group?.spaceLimitBytes != null ? BigInt(String(group.spaceLimitBytes)) : 10n * 1024n * 1024n * 1024n;
  return base + grantBytes(email);
}

/** 到期前 N 天写提醒（audit expire_notice；24h 内不重复写）。 */
function runNotify() {
  const cfg = billingConfig();
  const now = Date.now();
  const threshold = new Date(now + cfg.notifyOnExpireDays * 86400_000).toISOString();
  const users = db.prepare(
    "SELECT * FROM users WHERE groupExpiresAt IS NOT NULL AND groupExpiresAt > ? AND groupExpiresAt <= ?"
  ).all(new Date(now).toISOString(), threshold);

  let notified = 0;
  for (const u of users) {
    const recent = db.prepare(
      `SELECT id FROM audit WHERE email = ? AND action = 'expire_notice' AND at >= ? ORDER BY id DESC LIMIT 1`
    ).get(u.email, new Date(now - 24 * 3600_000).toISOString());
    if (recent) continue;
    writeAudit({ email: u.email, action: 'expire_notice', target: u.groupId, detail: `expiresAt:${u.groupExpiresAt}` });
    notified += 1;
  }
  return { notified, checked: users.length, notifyOnExpireDays: cfg.notifyOnExpireDays };
}

const JOBS = {
  notify: { exprKey: 'cronNotifyExpr', run: runNotify },
  ban: { exprKey: 'cronBanExpr', run: runBan },
};

function refreshExpr(name) {
  const job = JOBS[name];
  const cfg = billingConfig();
  const expr = cfg[job.exprKey];
  state.jobs[name].expr = expr;
  if (!state.jobs[name].nextRunAt) state.jobs[name].nextRunAt = nextRunAt(expr, new Date());
}

async function executeJob(name) {
  const rec = state.jobs[name];
  rec.lastRunAt = nowIso();
  try {
    const result = await JOBS[name].run();
    rec.lastOk = true;
    rec.lastResult = result;
    rec.lastError = null;
  } catch (e) {
    rec.lastOk = false;
    rec.lastError = String(e?.message || e);
    rec.lastResult = null;
  }
  rec.nextRunAt = nextRunAt(rec.expr, new Date());
}

async function tickJob(name) {
  const rec = state.jobs[name];
  if (!rec.nextRunAt || Date.now() < rec.nextRunAt.getTime()) return;
  await executeJob(name);
}

function tick() {
  for (const name of Object.keys(JOBS)) {
    refreshExpr(name);
    tickJob(name).catch((e) => {
      state.jobs[name].lastOk = false;
      state.jobs[name].lastError = String(e?.message || e);
    });
  }
}

/** 启动调度器（不阻塞 boot；timer unref）。 */
export function start() {
  if (state.started) return;
  state.started = true;
  for (const name of Object.keys(JOBS)) refreshExpr(name);
  state.timer = setInterval(tick, TICK_MS);
  if (state.timer.unref) state.timer.unref();
}

/** 退出清理。 */
export function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
}

/** 测试 / 管理端手动触发某个任务（跳过排程判定，立即执行）；返回最近一次状态。 */
export async function runJob(name) {
  if (!JOBS[name]) throw new Error(`unknown cron job: ${name}`);
  await executeJob(name);
  return state.jobs[name];
}

/** GET /api/admin/store/cron：表达式与最近一次执行时间/结果。 */
export function cronStatus() {
  const cfg = billingConfig();
  return {
    notify: {
      expr: cfg.cronNotifyExpr,
      lastRunAt: state.jobs.notify.lastRunAt,
      lastOk: state.jobs.notify.lastOk,
      lastResult: state.jobs.notify.lastResult,
      lastError: state.jobs.notify.lastError,
      nextRunAt: state.jobs.notify.nextRunAt ? state.jobs.notify.nextRunAt.toISOString() : null,
    },
    ban: {
      expr: cfg.cronBanExpr,
      lastRunAt: state.jobs.ban.lastRunAt,
      lastOk: state.jobs.ban.lastOk,
      lastResult: state.jobs.ban.lastResult,
      lastError: state.jobs.ban.lastError,
      nextRunAt: state.jobs.ban.nextRunAt ? state.jobs.ban.nextRunAt.toISOString() : null,
    },
  };
}
