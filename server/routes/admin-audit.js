import { Router } from 'express';
import { listAudit } from '../services/audit.js';

const router = Router();

router.get('/', (req, res) => {
  const { page, pageSize, action, email } = req.query;
  res.json(listAudit({ page, pageSize, action, email }));
});

export default router;
