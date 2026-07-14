import { Request, Response } from 'express';
import { project } from '../data/mockData';

/**
 * GET /api/project
 * Returns the active project descriptor including its media asset list.
 */
export function getProject(_req: Request, res: Response): void {
  res.json({ success: true, data: project });
}
