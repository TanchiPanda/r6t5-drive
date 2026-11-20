import app from './app.js';
import { db, migrate, getSetting, setSetting } from './db.js';
import { ENV, DEFAULTS } from './config.js';
import { hashPassword, randomPassword } from './lib/session.js';
import { nowIso, genId } from './lib/format.js';
import { sweepExpired as sweepExpiredUploads } from './services/chunks.js';
import { start as startCron } from './services/cron.js';
import { printBanner } from './lib/banner.js';
import { logInfo, logError } from './lib/log.js';

printBanner();

migrate();

// 首次启动播种默认用户组
function seedDefaultGroup() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  if (count > 0) return;
  db.prepare(
    `INSERT INTO groups (id, name, spaceLimitBytes, maxFileSizeBytes, traffic7dLimitBytes, isDefault, createdAt)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(
    genId('g'), '标准用户',
    Number(DEFAULTS.spaceLimitBytes), Number(DEFAULTS.maxFileSizeBytes), Number(DEFAULTS.traffic7dLimitBytes),
    nowIso()
  );
}

// 首次启动引导管理员密码：环境变量优先，否则随机生成并只打印一次
function bootstrapAdmin() {
  const existing = getSetting('admin_password_hash');
  if (existing) return;
  let password;
  let source;
  if (ENV.ADMIN_PASSWORD) {
    password = ENV.ADMIN_PASSWORD;
    source = 'env';
  } else {
    password = randomPassword(12);
    source = 'generated';
  }
  setSetting('admin_password_hash', hashPassword(password));
  setSetting('admin_password_source', source);
  if (source === 'generated') {
    const line = '='.repeat(60);
    console.log(`\n${line}`);
    console.log('  R6T5 Drive 首次启动');
    console.log('  未检测到 ADMIN_PASSWORD，已随机生成管理员密码（仅显示这一次）：');
    console.log(`  管理员密码：${password}`);
    console.log('  登录入口：/admin/login');
    console.log(`${line}\n`);
  } else {
    console.log('[boot] 管理员密码来自环境变量 ADMIN_PASSWORD。');
  }
}

seedDefaultGroup();
bootstrapAdmin();

// P4：启动时清理一次过期分片上传会话，之后每小时扫一次（unref 不阻塞退出）
sweepExpiredUploads();
setInterval(sweepExpiredUploads, 3600 * 1000).unref();

// P9-C：启动内置 Cron（内存调度，unref 不阻塞 boot / 退出）
startCron();

app.listen(ENV.PORT, '0.0.0.0', () => {
  logInfo('boot', 'R6T5 Drive 已启动', {
    port: ENV.PORT,
    db: ENV.DB_PATH,
    storageRoot: ENV.STORAGE_ROOT,
    devAuth: ENV.DEV_AUTH ? 'on' : 'off',
  });
});

// 进程级异常也要在容器日志里留痕，否则 docker logs 只剩一条重启记录
process.on('unhandledRejection', (reason) => {
  logError('boot', '未处理的 Promise 拒绝', { reason: reason instanceof Error ? reason.message : reason });
});
process.on('uncaughtException', (err) => {
  logError('boot', '未捕获异常', { error: err?.message || err });
  process.exit(1);
});
