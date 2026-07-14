import { Router } from 'express';
import { pause, play, stop } from '../controllers/playback.controller';

const router = Router();

router.post('/play', play);
router.post('/pause', pause);
router.post('/stop', stop);

export default router;
