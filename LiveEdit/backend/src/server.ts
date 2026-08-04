import 'dotenv/config';
import { createServer } from 'http';
import { createApp } from './app';
import { initSocketServer } from './sockets';
import { logger } from './utils/logger';

const PORT = Number(process.env.PORT) || 5001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5174';

const app = createApp(CORS_ORIGIN);
const httpServer = createServer(app);

initSocketServer(httpServer, CORS_ORIGIN);

httpServer.listen(PORT, () => {
  logger.info(`Emerald Live Edit backend listening on http://localhost:${PORT}`);
  logger.info(`Socket.IO ready, accepting connections from ${CORS_ORIGIN}`);
});
