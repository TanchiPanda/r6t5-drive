// P5 集成状态汇总。挂载点：/api/integrations（requireUser 由挂载方套）。
// 未配置即明确未启用；aria2 仅在 configured 时真探测，探测失败 reachable:false，不 500。

import { Router } from 'express';
import { summarizeStatus } from '../services/integrations.js';

const router = Router();

router.get('/status', async (req, res, next) => {
  try {
    const status = await summarizeStatus();
    res.json(status);
  } catch (e) { next(e); }
});

export default router;
