import { Router } from 'express';
import { getProject } from '../controllers/project.controller';

const router = Router();

router.get('/project', getProject);

export default router;
