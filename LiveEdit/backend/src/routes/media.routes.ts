import { Router } from 'express';
import { getImportedMedia, importMedia } from '../controllers/media.controller';

const router = Router();

router.get('/media/imports', getImportedMedia);
// No body parser in front of this: importMedia streams the raw request straight to disk. See its
// comment for why the upload is not multipart.
router.post('/media/import', importMedia);

export default router;
