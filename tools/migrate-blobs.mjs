// 历史文件迁移：把 nodes 里没有 blobId 的文件搬进扁平布局 uploads/<索引>/<原文件名>。
// 只处理 volume 策略（远端策略请改用「重新上传」）；默认 dry-run，确认后加 --confirm。
// 用法：DB_PATH=... STORAGE_ROOT=... node tools/migrate-blobs.mjs [--confirm]
import { db, migrate } from '../server/db.js';
import { getStrategy } from '../server/services/storage/registry.js';
import { writeBlobFromTemp, finalizeBlob, reserveBlob, dropReservedBlob } from '../server/services/blobs.js';
import { getDriver } from '../server/services/storage/driver.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

migrate();
const confirm = process.argv.includes('--confirm');
const rows = db.prepare('SELECT * FROM nodes WHERE isDir = 0 AND blobId IS NULL ORDER BY email, path').all();
let ok = 0, skipped = 0, failed = 0;
for (const n of rows) {
  const strategy = n.storageId ? getStrategy(n.storageId) : null;
  if (!strategy) { console.log(`SKIP  ${n.path}（无策略）`); skipped++; continue; }
  if (strategy.type !== 'volume') { console.log(`SKIP  ${n.path}（${strategy.type} 远端策略，需重新上传）`); skipped++; continue; }
  if (!confirm) { console.log(`PLAN  ${n.path} → uploads/<索引>/${n.name}`); ok++; continue; }
  const tmp = path.join(os.tmpdir(), `mig-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const src = await getDriver(strategy.type).readStream(strategy, n.path, { size: Number(n.sizeBytes), mime: n.mime, name: n.name });
    await pipeline(src, fs.createWriteStream(tmp));
    const blob = await writeBlobFromTemp({ strategy, filename: n.name, tmpFile: tmp, sizeBytes: Number(n.sizeBytes), mime: n.mime, createdBy: n.email });
    db.prepare('UPDATE nodes SET blobId = ?, updatedAt = ? WHERE id = ?').run(blob.id, new Date().toISOString(), n.id);
    await getDriver(strategy.type).remove(strategy, n.path, { size: Number(n.sizeBytes), mime: n.mime });
    console.log(`OK    ${n.path} → ${blob.storageKey}`);
    ok++;
  } catch (e) {
    console.log(`FAIL  ${n.path}：${e.message}`);
    failed++;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
console.log(`\n${confirm ? '已迁移' : '待迁移'} ${ok}，跳过 ${skipped}，失败 ${failed}`);
