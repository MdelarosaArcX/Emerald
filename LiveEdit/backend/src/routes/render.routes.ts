import { Router } from 'express';
import { requestRender } from '../controllers/render.controller';

const router = Router();

router.post('/render', requestRender);

export default router;
