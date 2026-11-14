import { Router } from 'express';
import { notImplemented } from '../lib/errors.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ items: [], available: false });
});

router.post('/', (req, res, next) => next(notImplemented('分享创建在 P2 规划中')));

router.get('/:token', (req, res, next) => next(notImplemented('分享访问在 P2 规划中')));

export default router;
