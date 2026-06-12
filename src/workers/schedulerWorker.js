// Scheduler Worker: picks due trips from Redis and pushes them to the matching queue.
const { Worker } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const redisStateService = require('../services/redisStateService');
const tripService = require('../services/tripService');
const { addMatchingJob } = require('../queues/matchingQueue');
const logger = require('../utils/logger');

// Dedicated Redis connection for scheduler worker
const connection = createClientConnection();

const schedulerWorker = new Worker(
  config.queues.scheduler,
  async (job) => {
    logger.debug(`Scheduler worker received job: ${job.name}`);
    if (job.name !== 'poll_due_trips') {
      return;
    }

    try {
      // Find up to 50 trip IDs that are due (scheduledTime <= now)
      const limit = 50;
      const dueTripIds = await redisStateService.getNextDueTrips(limit);
      if (!dueTripIds || dueTripIds.length === 0) {
        return;
      }

      logger.info(`Found ${dueTripIds.length} due trips in scheduler set. Processing sequentially...`);

      for (const tripId of dueTripIds) {
        try {
          // 1. Fetch trip document from MongoDB
          const trip = await tripService.getTripById(tripId);
          if (!trip) {
            logger.warn(`Trip ${tripId} not found in database. Removing from scheduler...`);
            await redisStateService.removeTripFromScheduler(tripId);
            continue;
          }

          // If trip is not pending, it might be cancelled/completed. Skip and clean up.
          if (trip.status !== 'PENDING') {
            logger.info(`Trip ${tripId} status is ${trip.status} (expected PENDING). Skipping and removing...`);
            await redisStateService.removeTripFromScheduler(tripId);
            continue;
          }

          // 2. Check matching_status in Redis to prevent concurrent matching jobs
          const matchingStatus = await redisStateService.getTripMatchingStatus(tripId);
          if (matchingStatus === 'in_progress' || matchingStatus === 'allocated') {
            logger.info(`Trip ${tripId} already matching or allocated in Redis. Skipping...`);
            await redisStateService.removeTripFromScheduler(tripId);
            continue;
          }

          // 3. Set matching_status to "in_progress" in Redis
          await redisStateService.setTripMatchingStatus(tripId, 'in_progress');

          // 4. Update trip status to "MATCHING" in MongoDB
          await tripService.markTripAsMatching(tripId);

          // 5. Get current attempt count from Redis (default to 0)
          const currentAttempt = await redisStateService.getAttemptCount(tripId) || 0;

          // 6. Get excluded drivers from Redis
          const excludedDrivers = await redisStateService.getExcludedDrivers(tripId);

          // 7. Push job to ad_matching queue
          await addMatchingJob({
            tripId,
            attempt: currentAttempt + 1,
            excludedDriverIds: Array.from(excludedDrivers)
          });

          // 8. Remove trip from scheduler sorted set
          await redisStateService.removeTripFromScheduler(tripId);
          logger.info(`Trip ${tripId} dispatched to matching queue. attempt: ${currentAttempt + 1}`);

        } catch (tripErr) {
          logger.error(`Error processing due trip ${tripId}: ${tripErr.message}`, { error: tripErr });
        }
      }
    } catch (err) {
      logger.error(`Scheduler worker process execution failed: ${err.message}`, { error: err });
      throw err;
    }
  },
  {
    connection,
    concurrency: 1 // process sequentially in the same run
  }
);

schedulerWorker.on('error', (err) => {
  logger.error(`Scheduler Worker connection/runtime error: ${err.message}`, { error: err });
});

schedulerWorker.startSchedulerWorker = () => schedulerWorker;

module.exports = schedulerWorker;
