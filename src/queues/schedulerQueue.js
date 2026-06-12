// Scheduler Queue: manages queuing of jobs for scheduled acting driver trips.
const { Queue } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const logger = require('../utils/logger');

// Create dedicated connection for this queue instance
const connection = createClientConnection();

const schedulerQueue = new Queue(config.queues.scheduler, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
});

/**
 * Validates data and adds a job to the scheduler queue.
 * @param {Object} data 
 * @param {string} data.tripId 
 * @param {number} data.scheduledTime 
 * @param {string} data.regionCode 
 */
const addSchedulerJob = async (data) => {
  if (!data || typeof data.tripId !== 'string' || typeof data.scheduledTime !== 'number' || typeof data.regionCode !== 'string') {
    throw new Error('Invalid job data for Scheduler queue. Must contain tripId (String), scheduledTime (Number), and regionCode (String).');
  }
  
  logger.info(`Adding scheduler job for trip ${data.tripId}`);
  return await schedulerQueue.add('scheduler_job', data, { jobId: data.tripId });
};

module.exports = {
  schedulerQueue,
  addSchedulerJob
};
