// Timeout Worker: processes delayed timeout verification check jobs from dispatching.
const redisStateService = require('../services/redisStateService');
const tripService = require('../services/tripService');
const matchingService = require('../services/matchingService');
const { addMatchingJob } = require('../queues/matchingQueue');
const { addCleanupJob } = require('../queues/cleanupQueue');
const { MATCH_EVENTS, FAILURE_REASONS, MATCHING_CONFIG } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Processes the delayed timeout verification check.
 * @param {Object} job - BullMQ job structure
 */
const handleTimeoutCheck = async (job) => {
  const { tripId, attempt } = job.data;
  logger.info(`Timeout Check: Processing expiration for trip ${tripId}, attempt ${attempt}`);

  try {
    // 1. Fetch trip profile details from MongoDB
    const trip = await tripService.getTripById(tripId);
    if (!trip) {
      logger.error(`Timeout Check: Trip ${tripId} not found in database.`);
      return;
    }

    // 2. Extract matching status from Redis. If "allocated", drop further validation immediately.
    const matchStatus = await redisStateService.getTripMatchingStatus(tripId);
    if (matchStatus === 'allocated') {
      logger.info(`Timeout Check: Trip ${tripId} is already allocated. Skipping timeout.`);
      return;
    }

    // 3. Compare current attempt count from Redis. If it has already advanced, this is a stale timeout check.
    const currentAttempt = await redisStateService.getAttemptCount(tripId);
    if (currentAttempt !== attempt) {
      logger.info(`Timeout Check: Stale check for trip ${tripId}. Current attempt is ${currentAttempt}, job was for ${attempt}. Skipping.`);
      return;
    }

    const maxAttempts = MATCHING_CONFIG.MAX_ATTEMPTS || 3;

    // 4. If attempt reaches max limits: Fail the trip
    if (attempt === maxAttempts) {
      logger.warn(`Timeout Check: Trip ${tripId} reached max attempts (${maxAttempts}) via timeout. Failing trip.`);
      
      // Update status to failed
      await tripService.markTripAsFailed(tripId, FAILURE_REASONS.NO_AVAILABLE_DRIVERS);

      // Log match_failed event in MongoDB
      const failLog = matchingService.buildMatchLog(MATCH_EVENTS.MATCH_FAILED, null, {
        attempt,
        reason: FAILURE_REASONS.NO_AVAILABLE_DRIVERS
      });
      await tripService.appendMatchLog(tripId, [failLog]);

      // Push job to ad_cleanup
      await addCleanupJob({ tripId, reason: 'failed' });
      return;
    }

    // 5. If attempt < max attempts: Capture non-responding drivers and re-trigger match
    if (attempt < maxAttempts) {
      const shortlist = await redisStateService.getShortlist(tripId);
      const responses = await redisStateService.getDriverResponses(tripId);

      const nonResponsiveDrivers = [];
      for (const driverId of shortlist) {
        if (!responses[driverId]) {
          // Record timeout response in Redis
          await redisStateService.recordDriverResponse(tripId, driverId, 'timeout');
          
          // Exclude driver from future rounds
          await redisStateService.addExcludedDriver(tripId, driverId);
          nonResponsiveDrivers.push(driverId);

          // Append log to MongoDB rideMatchLog
          const timeoutLog = matchingService.buildMatchLog(MATCH_EVENTS.DRIVER_TRIP_RESPONSE, driverId, {
            response: 'timeout',
            reason: 'No response received within timeout window'
          });
          await tripService.appendMatchLog(tripId, [timeoutLog]);
        }
      }

      if (nonResponsiveDrivers.length > 0) {
        logger.info(`Timeout Check: Drivers timed out for trip ${tripId}: ${nonResponsiveDrivers.join(', ')}`);
      }

      // Re-queue matching job for attempt + 1
      const allExcluded = await redisStateService.getExcludedDrivers(tripId);
      await addMatchingJob({
        tripId,
        attempt: attempt + 1,
        excludedDriverIds: Array.from(allExcluded)
      });
    }

  } catch (err) {
    logger.error(`Timeout Check: Error processing timeout for trip ${tripId}: ${err.message}`, { error: err });
    throw err;
  }
};

module.exports = {
  handleTimeoutCheck,
  startTimeoutWorker: () => {
    return {
      close: async () => {
        logger.info('Timeout worker closed (delegated to matchingWorker).');
      }
    };
  }
};
