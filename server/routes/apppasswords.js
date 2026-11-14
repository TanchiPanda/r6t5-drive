// 应用密码管理接口（/api/account/app-passwords）。
// 会话鉴权由上层挂载处套 requireUser；本路由不做 cookie 校验。
import { Router } from 'express';
import {
  createAppPassword, listAppPasswords, revokeAppPassword,
} from '../services/apppasswords.js';

const router = Router();

// GET /api/account/app-passwords → 列表（永不返回 password / hash / salt）
router.get('/', (req, res, next) => {
  try {
    res.json({ items: listAppPasswords(req.user.email) });
  } catch (e) { next(e); }
});

// POST /api/account/app-passwords  body { name } → 201 { item, password }
// password 只在这一次响应里以明文返回；库里只存派生值。
router.post('/', (req, res, next) => {
  try {
    const { name } = req.body || {};
    const result = createAppPassword({ email: req.user.email, name });
    res.status(201).json({ item: result.item, password: result.password });
  } catch (e) { next(e); }
});

// DELETE /api/account/app-passwords/:id → 撤销（幂等，只能删自己的）
router.delete('/:id', (req, res, next) => {
  try {
    res.json(revokeAppPassword({ id: req.params.id, email: req.user.email }));
  } catch (e) { next(e); }
});

// POST /:id/revoke 与 DELETE 等价
router.post('/:id/revoke', (req, res, next) => {
  try {
    res.json(revokeAppPassword({ id: req.params.id, email: req.user.email }));
  } catch (e) { next(e); }
});

export default router;
