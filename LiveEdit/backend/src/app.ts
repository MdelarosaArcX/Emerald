import cors from 'cors';
import express, { Application, NextFunction, Request, Response } from 'express';
import { PROXY_DIR, RENDER_DIR } from './controllers/render.controller';
import captureRoutes from './routes/capture.routes';
import playbackRoutes from './routes/playback.routes';
import projectRoutes from './routes/project.routes';
import renderRoutes from './routes/render.routes';
import statusRoutes from './routes/status.routes';
import timelineRoutes from './routes/timeline.routes';
import { logger } from './utils/logger';

/**
 * Builds and configures the Express application.
 * Kept separate from server.ts so it can be imported in tests
 * without binding to a port.
 */
export function createApp(corsOrigin: string): Application {
  const app = express();

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.originalUrl}`);
    next();
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ success: true, service: 'emerald-live-edit-backend', status: 'ok' });
  });

  // Generated media (browser-playable proxies and rendered sequence outputs).
  app.use('/proxies', express.static(PROXY_DIR));
  app.use('/renders', express.static(RENDER_DIR));

  app.use('/api', projectRoutes);
  app.use('/api', timelineRoutes);
  app.use('/api', playbackRoutes);
  app.use('/api', captureRoutes);
  app.use('/api', renderRoutes);
  app.use('/api', statusRoutes);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ success: false, error: `Route not found: ${req.originalUrl}` });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });

  return app;
}
