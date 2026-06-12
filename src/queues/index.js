// Queues Index: exports all BullMQ queues and helper job adders.
const { schedulerQueue, addSchedulerJob } = require('./schedulerQueue');
const { matchingQueue, addMatchingJob } = require('./matchingQueue');
const { dispatchQueue, addDispatchJob } = require('./dispatchQueue');
const { cleanupQueue, addCleanupJob } = require('./cleanupQueue');

module.exports = {
  schedulerQueue,
  addSchedulerJob,
  matchingQueue,
  addMatchingJob,
  dispatchQueue,
  addDispatchJob,
  cleanupQueue,
  addCleanupJob
};
