import fs from 'fs';
import path from 'path';

/**
 * Filesystem locations for media this backend owns.
 *
 * Kept here rather than on the controller that uses each one because more than one module needs
 * them: media.controller writes imports, render.controller has to resolve an import's URL back to
 * its local file, and app.ts serves the directory statically. Declaring IMPORT_DIR on
 * media.controller made render.controller import it and media.controller import FFPROBE back —
 * a cycle, and one whose resolution order would only bite at runtime.
 */
export const MEDIA_CACHE_ROOT = path.resolve(process.cwd(), '.media-cache');

/** Media imported into the project, served at /media-imports. */
export const IMPORT_DIR = path.join(MEDIA_CACHE_ROOT, 'imports');

fs.mkdirSync(IMPORT_DIR, { recursive: true });
