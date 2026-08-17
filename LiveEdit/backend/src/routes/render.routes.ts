import { Router } from 'express';
import { requestProxy, requestRender, requestSourceTimecode, requestWaveform } from '../controllers/render.controller';

const router = Router();

router.post('/proxy', requestProxy);
router.post('/render', requestRender);
router.get('/waveform', requestWaveform);
router.get('/source-timecode', requestSourceTimecode);

export default router;
