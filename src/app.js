// App: entrypoint file that connects databases, registers BullMQ queues, mounts API routes, and listens on port.
const express = require('express');
const { connectDB } = require('./config/db');
const { redisClient } = require('./config/redis');
const { startSchedulerWorker } = require('./workers/schedulerWorker');
const { startMatchingWorker } = require('./workers/matchingWorker');
const { startTimeoutWorker } = require('./workers/timeoutWorker');
const { startCleanupWorker } = require('./workers/cleanupWorker');
const dispatchWorker = require('./workers/dispatchWorker');
const { initSocketGateway } = require('./socket/gateway');
const logger = require('./utils/logger');
const queues = require('./queues');

const app = express();

async function bootstrapEngine() {
  try {
    // 1. Enforce strict variable compliance check loops
    require('./config/env');

    // 2. Validate state machine connectivity infrastructure bounds
    await connectDB();
    await redisClient.ping();
    logger.info('Database layers verified successfully.');

    // 3. Mount REST communication layers
    app.use(express.json());
    
    // Register trip booking ingestion routers
    app.use('/api/v2/trips', require('./api/routes/tripRoutes'));
    // Keep Part 1 & 2 path mounts for compatibility
    app.use('/api/trips', require('./api/routes/tripRoutes'));
    app.use('/api/drivers', require('./api/routes/driverRoutes'));

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.status(200).json({ status: 'ok', timestamp: Date.now() });
    });

    // 4. Initialize specialized background queue processors
    const schedulerWorker = startSchedulerWorker();
    const matchingWorker = startMatchingWorker();
    const timeoutWorker = startTimeoutWorker();
    const cleanupWorker = startCleanupWorker();

    // Setup repeatable scheduler poll job on startup
    logger.info('Registering repeatable due trip scheduler poll job...');
    await queues.schedulerQueue.add(
      'poll_due_trips',
      {},
      {
        repeat: { every: 5000 },
        jobId: 'poll_due_trips' // Prevent duplicate registrations
      }
    );

    const port = process.env.PORT || 3001;
    const server = app.listen(port, () => {
      logger.info(`Engine active on port space: ${port}`);
    });

    // Initialize Socket.IO Gateway attached to server
    logger.info('Initializing Socket.IO Gateway...');
    initSocketGateway(server);

    // 5. Graceful shutdown handler
    const shutdownHandler = async (signal) => {
      logger.warn(`Signal received: ${signal}. Shutting down workers.`);
      try {
        await schedulerWorker.close();
        await matchingWorker.close();
        await timeoutWorker.close();
        await cleanupWorker.close();
        await dispatchWorker.close();
        await redisClient.quit();
        server.close(() => {
          logger.info('Engine terminated cleanly.');
          process.exit(0);
        });
      } catch (err) {
        logger.error(`Error during graceful shutdown: ${err.message}`);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
    process.on('SIGINT', () => shutdownHandler('SIGINT'));

    return server;
  } catch (error) {
    logger.error(`Critical validation block failure: ${error.message}`);
    process.exit(1);
  }
}

// Auto-execute start script if run directly
if (require.main === module) {
  bootstrapEngine();
}

module.exports = { app, bootstrapEngine };
