import { Request, Response } from 'express';
import { project } from '../data/mockData';
import { listImportedAssets } from './media.controller';

/**
 * GET /api/project
 * Returns the active project descriptor including its media asset list.
 *
 * Imported media is merged in at read time rather than pushed into the mockData array, so the
 * imports directory's index stays the single source of truth for what has been imported — a
 * mutated module-level array would drift from it on every backend restart. Imports come first
 * because they are what the operator most recently added.
 */
export function getProject(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: { ...project, mediaAssets: [...listImportedAssets(), ...project.mediaAssets] },
  });
}
