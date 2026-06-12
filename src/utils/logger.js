// Logger: configures winston for unified application logging, outputting JSON in production and pretty-print in development.
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, json, colorize, printf, metadata } = format;

const nodeEnv = process.env.NODE_ENV || 'development';

// Development pretty-print formatter
const devFormatter = printf(({ level, message, timestamp, metadata }) => {
  let metaStr = '';
  if (metadata && Object.keys(metadata).length > 0) {
    metaStr = ` ${JSON.stringify(metadata)}`;
  }
  return `[${timestamp}] ${level}: ${message}${metaStr}`;
});

// Configure Winston logger instance
const logger = createLogger({
  level: nodeEnv === 'production' ? 'info' : 'debug',
  transports: [
    new transports.Console({
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
        nodeEnv === 'production'
          ? json()
          : combine(colorize(), devFormatter)
      )
    })
  ]
});

module.exports = logger;
