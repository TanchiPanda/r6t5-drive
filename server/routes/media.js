// P5 媒体元数据路由（登录态由上层挂载 requireUser；本文件不做鉴权）。
// 挂载点：/api/files/info（需在既有 /api/files 之前挂载，避免被文件路由吞掉）。
// 只读文件头部（≤ 2 MB），消费完头部字节即 destroy 流；不整文件入内存。
import { Router } from 'express';
import { normalizeLogicalPath } from '../lib/paths.js';
import { ApiError, notFound } from '../lib/errors.js';
import { resolveStorage } from '../services/bindings.js';
import { getNodeByPath } from '../services/nodes.js';
import { getDriver } from '../services/storage/driver.js';
import { parseMedia, classifyMedia } from '../services/metadata.js';

const router = Router();

// 头部读取上限：2 MB（图片 EXIF / MP4 moov / EBML Info 均在头部）
const HEAD_LIMIT = 2 * 1024 * 1024;

/**
 * 从存储流读取前 HEAD_LIMIT 字节；读到上限或流结束即 destroy，不消费剩余内容。
 * 返回 { head: Buffer, sizeBytes: number|null }。读取失败抛 ApiError。
 */
async function readHead(strategy, logicalPath, node) {
  const driver = getDriver(strategy.type);
  const meta = { size: node ? Number(node.sizeBytes) : undefined, mime: node?.mime, name: logicalPath.split('/').pop() };
  const stream = await driver.readStream(strategy, logicalPath, meta);

  const chunks = [];
  let total = 0;

  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = HEAD_LIMIT - total;
      if (room <= 0) break;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      total += Math.min(buf.length, room);
      if (total >= HEAD_LIMIT) break;
    }
  } catch (e) {
    try { stream.destroy(); } catch {}
    throw e;
  } finally {
    try { stream.destroy(); } catch {}
  }

  const head = Buffer.concat(chunks, total);
  return { head };
}

// GET /api/files/info?path=<逻辑路径>
router.get('/', async (req, res, next) => {
  try {
    const logical = normalizeLogicalPath(String(req.query.path || ''), req.user.email);

    const hit = resolveStorage({ email: req.user.email, logicalPath: logical, user: req.user });
    if (!hit || !hit.strategy) {
      throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略，请联系管理员在后台添加一条');
    }
    const strategy = hit.strategy;

    const node = getNodeByPath(logical);
    if (node && node.isDir) throw notFound('目录不支持媒体元数据解析');

    const name = logical.split('/').pop();
    const sizeBytes = node ? Number(node.sizeBytes) : null;
    const mime = (node && node.mime) || 'application/octet-stream';

    let head = Buffer.alloc(0);
    try {
      const read = await readHead(strategy, logical, node);
      head = read.head;
    } catch (e) {
      // 远端/本地读取失败：节点不存在 → 404；其余降级为 parsed:false，不抛 500
      if (e && (e.status === 404 || e.code === 'not_found')) throw notFound('文件不存在');
      const classification = classifyMedia(logical, mime);
      return res.json({
        name, path: logical, sizeBytes, mime,
        kind: classification.kind, media: null, parsed: false,
        reason: `读取文件头部失败：${e && e.message ? e.message : '未知错误'}`,
      });
    }

    const result = parseMedia({ head, sizeBytes: sizeBytes || 0, mime, logicalPath: logical });

    res.json({
      name,
      path: logical,
      sizeBytes,
      mime,
      kind: result.kind,
      media: result.media,
      parsed: result.parsed,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  } catch (e) { next(e); }
});

export default router;
