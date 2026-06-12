// Matching Queue: manages queuing of jobs to identify and score candidates for a trip.
const { Queue } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const logger = require('../utils/logger');

// Create dedicated connection for this queue instance
const connection = createClientConnection();

const matchingQueue = new Queue(config.queues.matching, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
});

/**
 * Validates data and adds a job to the matching queue.
 * @param {Object} data 
 * @param {string} data.tripId 
 * @param {number} data.attempt - must be 1, 2, or 3
 * @param {string[]} data.excludedDriverIds 
 */
const addMatchingJob = async (data, opts = {}) => {
  if (!data || typeof data.tripId !== 'string' || typeof data.attempt !== 'number') {
    throw new Error('Invalid job data for Matching queue. Must contain tripId (String) and attempt (Number).');
  }

  if (data.isTimeoutCheck !== true && !Array.isArray(data.excludedDriverIds)) {
    throw new Error('Invalid job data for Matching queue. Must contain excludedDriverIds (Array).');
  }
  
  if (data.attempt < 1 || data.attempt > 3) {
    throw new Error('Invalid attempt value. Must be 1, 2, or 3.');
  }

  logger.info(`Adding matching job for trip ${data.tripId}, attempt ${data.attempt}${data.isTimeoutCheck ? ' (Timeout Check)' : ''}`);
  const jobId = opts.jobId || `${data.tripId}_matching_${data.attempt}`;
  return await matchingQueue.add('matching_job', data, { jobId, ...opts });
};

module.exports = {
  matchingQueue,
  addMatchingJob
};
