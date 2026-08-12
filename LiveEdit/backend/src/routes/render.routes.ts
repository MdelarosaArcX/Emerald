import { Router } from 'express';
import { requestProxy, requestRender, requestWaveform } from '../controllers/render.controller';

const router = Router();

router.post('/proxy', requestProxy);
router.post('/render', requestRender);
router.get('/waveform', requestWaveform);

export default router;
