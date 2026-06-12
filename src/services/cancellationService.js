// Cancellation Service: manages driver cancellations, counting retry limits and triggering rematches.
const Trip = require('../models/Trip');
const tripService = require('./tripService');
const redisStateService = require('./redisStateService');
const { addMatchingJob } = require('../queues/matchingQueue');
const { addCleanupJob } = require('../queues/cleanupQueue');
const { MATCHING_CONFIG } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Handles driver cancellations after allocation but before pickup.
 * @param {string} tripId 
 * @param {string} driverId 
 * @param {string} cancelReason 
 * @returns {Promise<Object>} success indicator
 */
const handleDriverCancellation = async (tripId, driverId, cancelReason) => {
  logger.info(`CancellationService: Driver ${driverId} cancelled trip ${tripId}. Reason: ${cancelReason}`);

  try {
    // 1. Fetch trip profile details from MongoDB
    const trip = await tripService.getTripById(tripId);
    if (!trip) {
      throw new Error(`Trip ${tripId} not found`);
    }

    // 2. Count prior CANCELLED_BY_DRIVER_BEFORE_PICKUP events in timeline
    const timeline = trip.tripTimeline || [];
    const cancelCount = timeline.filter(item => item.state === 'CANCELLED_BY_DRIVER_BEFORE_PICKUP').length;
    const maxRetries = MATCHING_CONFIG.MAX_CANCELLATION_RETRIES || 3;

    logger.info(`Trip ${tripId} has ${cancelCount} prior cancellations (Max allowed: ${maxRetries})`);

    // 3. If limit verification boundaries are broken: fail trip
    if (cancelCount >= maxRetries) {
      logger.warn(`Trip ${tripId} exceeded max cancellation retries. Failing trip.`);
      
      // Update trip status to failed in MongoDB
      await tripService.markTripAsFailed(tripId, 'MaxRetriesExceeded');
      
      // Push cleanup job to ad_cleanup
      await addCleanupJob({ tripId, reason: 'failed' });
      return { success: false, reason: 'MaxRetriesExceeded' };
    }

    // 4. If tracking metrics sit safely below maximum limits (< 3)
    // Flush active allocation indicators from cache
    await redisStateService.clearDriverActiveTrip(driverId);

    // Record new state transitions in MongoDB
    const timestamp = Date.now();
    await Trip.findByIdAndUpdate(
      tripId,
      {
        $set: { status: 'MATCHING' },
        $push: {
          tripTimeline: { state: 'CANCELLED_BY_DRIVER_BEFORE_PICKUP', timestamp },
          rideMatchLog: {
            event: 'rematch_triggered',
            driver_id: driverId,
            reason: cancelReason,
            timestamp
          }
        }
      },
      { new: true }
    );

    // Safely append the cancelling driver's unique ID to Redis exclusion set
    await redisStateService.addExcludedDriver(tripId, driverId);

    // Fetch all accumulated excluded drivers
    const allExcluded = await redisStateService.getExcludedDrivers(tripId);

    // Re-insert trip onto matching queue with attempt 1 and high priority
    await addMatchingJob(
      {
        tripId,
        attempt: 1,
        excludedDriverIds: Array.from(allExcluded)
      },
      {
        priority: 1 // high priority queue configuration
      }
    );

    logger.info(`CancellationService: Successfully triggered rematch attempt for trip ${tripId}`);
    return { success: true, reason: 'RematchTriggered' };

  } catch (err) {
    logger.error(`CancellationService: Failed to handle driver cancellation for trip ${tripId}: ${err.message}`, { error: err });
    throw err;
  }
};

module.exports = {
  handleDriverCancellation
};
