import { Router } from 'express';
import { importMedia, toggleCapture } from '../controllers/capture.controller';

const router = Router();

router.post('/import', importMedia);
router.post('/capture', toggleCapture);

export default router;
