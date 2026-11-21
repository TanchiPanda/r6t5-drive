// 用户端：打开方式关联表只读下发（需登录）。
// onlyoffice 行附带 available 标记（未配置 DS / JWT 时前端隐藏）。
import { Router } from 'express';
import { publicOpeners } from '../services/openers.js';

const router = Router();

router.get('/', (req, res, next) => {
  try {
    res.json({ items: publicOpeners() });
  } catch (e) { next(e); }
});

export default router;
