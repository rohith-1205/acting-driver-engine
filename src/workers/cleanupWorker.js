// Cleanup Worker: cleans up transient Redis keys after a trip matching sequence terminates.
const { Worker } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const redisStateService = require('../services/redisStateService');
const logger = require('../utils/logger');

// Dedicated Redis connection for cleanup worker
const connection = createClientConnection();

const processJob = async (job) => {
  const { tripId, reason } = job.data;
  logger.info(`Cleanup Worker: Processing cleanup for trip ${tripId}, reason: ${reason}`);

  try {
    // Execute the database key collection wipes
    await redisStateService.cleanupAllTripKeys(tripId);
    logger.info(`Cleanup Worker: Successfully cleaned up all Redis keys for trip ${tripId} (Reason: ${reason})`);
  } catch (err) {
    logger.error(`Cleanup Worker: Error cleaning up keys for trip ${tripId}: ${err.message}`, { error: err });
    throw err;
  }
};

const cleanupWorker = new Worker(
  config.queues.cleanup,
  processJob,
  {
    connection,
    concurrency: 5 // concurrency of 5 cleanup workers
  }
);

cleanupWorker.processJob = processJob;
cleanupWorker.on('error', (err) => {
  logger.error(`Cleanup Worker global error: ${err.message}`, { error: err });
});

cleanupWorker.startCleanupWorker = () => cleanupWorker;

module.exports = cleanupWorker;
