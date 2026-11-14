import { Router } from 'express';
import * as chunks from '../services/chunks.js';

const router = Router();

// POST /api/uploads/init
router.post('/init', (req, res, next) => {
  try {
    const view = chunks.initSession(req.user, req.body || {});
    res.status(201).json({
      uploadId: view.uploadId,
      chunkSize: view.chunkSize,
      totalChunks: view.totalChunks,
      received: view.received,
      expiresAt: view.expiresAt,
    });
  } catch (e) { next(e); }
});

// GET /api/uploads
router.get('/', (req, res, next) => {
  try {
    res.json({ items: chunks.listSessions(req.user) });
  } catch (e) { next(e); }
});

// GET /api/uploads/:id
router.get('/:id', (req, res, next) => {
  try {
    res.json({ item: chunks.getSession(req.user, req.params.id) });
  } catch (e) { next(e); }
});

// PUT /api/uploads/:id/part/:index —— 请求体为分片二进制原始流（非 multipart）
router.put('/:id/part/:index', (req, res, next) => {
  const contentLength = req.headers['content-length'] != null
    ? Number(req.headers['content-length'])
    : undefined;
  chunks.putPart(req.user, req.params.id, req.params.index, req, contentLength)
    .then((result) => res.status(200).json(result))
    .catch(next);
});

// POST /api/uploads/:id/complete
router.post('/:id/complete', (req, res, next) => {
  chunks.completeSession(req.user, req.params.id, { mime: req.body?.mime })
    .then((result) => res.status(201).json(result))
    .catch(next);
});

// DELETE /api/uploads/:id —— 中止并清理（幂等）
router.delete('/:id', (req, res, next) => {
  try {
    res.json(chunks.abortSession(req.user, req.params.id));
  } catch (e) { next(e); }
});

export default router;
