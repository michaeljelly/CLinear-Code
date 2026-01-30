import express from 'express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { handleLinearWebhook, verifyWebhookSignature } from './linear/webhook-handler.js';

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// Linear webhook endpoint
app.post(
  '/webhook/linear',
  verifyWebhookSignature,
  handleLinearWebhook
);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(`Server started on ${config.HOST}:${config.PORT}`);
  logger.info(`Webhook endpoint: POST /webhook/linear`);
  logger.info(`Health check: GET /health`);
  logger.info(`Compute provider: ${config.COMPUTE_PROVIDER}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
