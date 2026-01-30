import winston from 'winston';
import path from 'path';
import fs from 'fs';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Determine log directory - use /var/log/clinear if running as service, or ./logs locally
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error(`Failed to create log directory ${LOG_DIR}:`, err);
}

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let log = `${timestamp} [${level}]: ${message}`;

  if (stack) {
    log += `\n${stack}`;
  }

  if (Object.keys(meta).length > 0) {
    log += ` ${JSON.stringify(meta, null, 2)}`;
  }

  return log;
});

// File format without colors
const fileFormat = combine(
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  logFormat
);

// Console format with colors
const consoleFormat = combine(
  colorize(),
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  logFormat
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug', // Default to debug for better visibility
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // Combined log file - all levels
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'clinear.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // Error log file - errors only
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'clinear-error.log'),
      format: fileFormat,
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // Webhook-specific log file for easier debugging
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'webhook.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
    }),
  ],
});

// Log startup information
logger.info(`Logging initialized - logs written to ${LOG_DIR}`);
