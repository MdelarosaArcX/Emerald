import { Router } from 'express';
import { requestProxy, requestRender } from '../controllers/render.controller';

const router = Router();

router.post('/proxy', requestProxy);
router.post('/render', requestRender);

export default router;
