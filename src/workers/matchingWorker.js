// Matching Worker: processes matching jobs, searches for and scores eligible drivers for a trip.
const { Worker } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const redisStateService = require('../services/redisStateService');
const tripService = require('../services/tripService');
const matchingService = require('../services/matchingService');
const { addMatchingJob } = require('../queues/matchingQueue');
const { addDispatchJob } = require('../queues/dispatchQueue');
const { addCleanupJob } = require('../queues/cleanupQueue');
const { MATCHING_CONFIG, FAILURE_REASONS, MATCH_EVENTS } = require('../utils/constants');
const logger = require('../utils/logger');

// Dedicated Redis connection for matching worker
const connection = createClientConnection();

const matchingWorker = new Worker(
  config.queues.matching,
  async (job) => {
    const { tripId, attempt, excludedDriverIds, isTimeoutCheck } = job.data;

    if (isTimeoutCheck === true) {
      const { handleTimeoutCheck } = require('./timeoutWorker');
      await handleTimeoutCheck(job);
      return;
    }

    logger.info(`Processing matching job for trip ${tripId}, attempt ${attempt}`);

    const maxAttempts = MATCHING_CONFIG.MAX_ATTEMPTS || 3;

    try {
      // STEP 1 — Load trip from MongoDB
      const trip = await tripService.getTripById(tripId);
      if (!trip) {
        logger.error(`Trip ${tripId} not found in MongoDB. Terminating matching sequence.`);
        return; // Terminate (do not retry)
      }

      if (trip.status === 'CANCELLED' || trip.status === 'COMPLETED') {
        logger.info(`Trip ${tripId} is already ${trip.status}. Skipping matching...`);
        return; // Terminate (do not retry)
      }

      // STEP 2 — Validate attempt count
      if (attempt > maxAttempts) {
        logger.warn(`Trip ${tripId} matching exceeded maximum retry attempts (${maxAttempts}). Failing trip.`);
        await tripService.markTripAsFailed(tripId, FAILURE_REASONS.MAX_RETRIES_EXCEEDED);
        await addCleanupJob({ tripId, reason: 'failed' });
        return;
      }

      // Keep Mongoose trip matchAttempt count in sync
      await tripService.updateTripAttempt(tripId, attempt);

      // STEP 3 — Update attempt count in Redis
      await redisStateService.setAttemptCount(tripId, attempt);

      // STEP 4 — Add current run's excludedDriverIds to Redis excluded set
      if (Array.isArray(excludedDriverIds)) {
        for (const driverId of excludedDriverIds) {
          await redisStateService.addExcludedDriver(tripId, driverId);
        }
      }

      // STEP 5 — Call matchingService to find eligible drivers
      const shortlist = await matchingService.findEligibleDrivers(trip, attempt);

      if (shortlist.length === 0) {
        if (attempt < maxAttempts) {
          logger.info(`No drivers found for trip ${tripId} on attempt ${attempt}. Triggering retry round ${attempt + 1}.`);
          
          // Get all accumulated excluded drivers to carry forward
          const allExcluded = await redisStateService.getExcludedDrivers(tripId);
          
          await addMatchingJob({
            tripId,
            attempt: attempt + 1,
            excludedDriverIds: Array.from(allExcluded)
          });
          return;
        } else {
          logger.warn(`Trip ${tripId} matching failed. Max attempts reached. Marking as failed.`);
          await tripService.markTripAsFailed(tripId, FAILURE_REASONS.NO_AVAILABLE_DRIVERS);
          
          // Append match failed log
          const failLog = matchingService.buildMatchLog(MATCH_EVENTS.MATCH_FAILED, null, {
            attempt,
            reason: FAILURE_REASONS.NO_AVAILABLE_DRIVERS
          });
          await tripService.appendMatchLog(tripId, [failLog]);
          
          // Trigger cleanup
          await addCleanupJob({ tripId, reason: 'failed' });
          return;
        }
      }

      // STEP 6 — Store shortlist driver IDs in Redis
      const driverIds = shortlist.map(d => d.driverId);
      await redisStateService.setShortlist(tripId, driverIds);

      // STEP 7 — Append match attempt log entries to MongoDB trip
      const fareAmount = trip.estimatedFare || trip.minFare || 0;
      const logEntries = shortlist.map(driver => {
        return matchingService.buildMatchLog(MATCH_EVENTS.TRIP_REQUEST_ATTEMPT, driver.driverId, {
          fare: fareAmount,
          currency: "₹",
          escalation_details: {
            escalation_count: attempt,
            estimated_fare: fareAmount,
            escalation_bonus: 0
          }
        });
      });
      await tripService.appendMatchLog(tripId, logEntries);

      // STEP 8 — Push job to ad_dispatch queue
      await addDispatchJob({
        tripId,
        shortlistedDriverIds: driverIds,
        fareAmount,
        attempt
      });

      // STEP 9 — Log success
      logger.info(`Matching complete for trip ${tripId} attempt ${attempt}, shortlisted ${shortlist.length} drivers`);

    } catch (err) {
      logger.error(`Error matching trip ${tripId} at attempt ${attempt}: ${err.message}`, { error: err });
      
      if (attempt < maxAttempts) {
        // Re-throw so BullMQ handles worker retries (uses backoff delay)
        throw err;
      } else {
        // Mark as failed and run cleanup
        try {
          await tripService.markTripAsFailed(tripId, FAILURE_REASONS.MAX_RETRIES_EXCEEDED);
          await addCleanupJob({ tripId, reason: 'failed' });
        } catch (dbErr) {
          logger.error(`Failed to execute fail fallback database updates for trip ${tripId}: ${dbErr.message}`);
        }
      }
    }
  },
  {
    connection,
    concurrency: 5 // concurrency of 5 matching workers
  }
);

matchingWorker.on('error', (err) => {
  logger.error(`Matching Worker global error: ${err.message}`, { error: err });
});

matchingWorker.startMatchingWorker = () => matchingWorker;

module.exports = matchingWorker;
