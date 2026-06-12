// Cleanup Queue: manages queuing of jobs to clean up transient Redis keys after trip resolution.
const { Queue } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const logger = require('../utils/logger');

// Create dedicated connection for this queue instance
const connection = createClientConnection();

const cleanupQueue = new Queue(config.queues.cleanup, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
});

/**
 * Validates data and adds a job to the cleanup queue.
 * @param {Object} data 
 * @param {string} data.tripId 
 * @param {string} data.reason - "allocated" | "failed" | "cancelled"
 */
const addCleanupJob = async (data) => {
  if (!data || typeof data.tripId !== 'string' || typeof data.reason !== 'string') {
    throw new Error('Invalid job data for Cleanup queue. Must contain tripId (String) and reason (String).');
  }

  const validReasons = ['allocated', 'failed', 'cancelled'];
  if (!validReasons.includes(data.reason)) {
    throw new Error(`Invalid cleanup reason. Must be one of: ${validReasons.join(', ')}`);
  }

  logger.info(`Adding cleanup job for trip ${data.tripId}, reason ${data.reason}`);
  return await cleanupQueue.add('cleanup_job', data, { jobId: `${data.tripId}_cleanup` });
};

module.exports = {
  cleanupQueue,
  addCleanupJob
};
