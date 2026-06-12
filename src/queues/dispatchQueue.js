// Dispatch Queue: manages queuing of jobs to dispatch ride request notifications to shortlisted drivers.
const { Queue } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const logger = require('../utils/logger');

// Create dedicated connection for this queue instance
const connection = createClientConnection();

const dispatchQueue = new Queue(config.queues.dispatch, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
});

/**
 * Validates data and adds a job to the dispatch queue.
 * @param {Object} data 
 * @param {string} data.tripId 
 * @param {string[]} data.shortlistedDriverIds 
 * @param {number} data.fareAmount 
 * @param {number} data.attempt 
 */
const addDispatchJob = async (data) => {
  if (!data || typeof data.tripId !== 'string' || !Array.isArray(data.shortlistedDriverIds) || typeof data.fareAmount !== 'number' || typeof data.attempt !== 'number') {
    throw new Error('Invalid job data for Dispatch queue. Must contain tripId (String), shortlistedDriverIds (Array), fareAmount (Number), and attempt (Number).');
  }

  logger.info(`Adding dispatch job for trip ${data.tripId}, attempt ${data.attempt}`);
  return await dispatchQueue.add('dispatch_job', data, { jobId: `${data.tripId}_dispatch_${data.attempt}` });
};

module.exports = {
  dispatchQueue,
  addDispatchJob
};
