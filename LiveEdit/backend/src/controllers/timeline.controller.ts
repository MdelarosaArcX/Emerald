import { Request, Response } from 'express';
import { timeline } from '../data/mockData';

/**
 * GET /api/timeline
 * Returns the full timeline document (tracks + clips + playhead).
 */
export function getTimeline(_req: Request, res: Response): void {
  res.json({ success: true, data: timeline });
}
