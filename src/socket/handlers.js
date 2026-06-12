// Socket Event Handlers: defines WebSocket events for driver acceptance and rejections.
const redisStateService = require('../services/redisStateService');
const tripService = require('../services/tripService');
const matchingService = require('../services/matchingService');
const Trip = require('../models/Trip');
const { addMatchingJob } = require('../queues/matchingQueue');
const { addCleanupJob } = require('../queues/cleanupQueue');
const { MATCH_EVENTS, FAILURE_REASONS } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Registers events for incoming driver Socket.IO connections
 * @param {Server} io - Socket.IO server instance
 * @param {Socket} socket - Single socket client connection instance
 */
const registerHandlers = (io, socket) => {
  /**
   * Active Rejection Handler
   * Event: driver_reject
   * Payload: { tripId: String, driverId: String }
   */
  socket.on('driver_reject', async (data) => {
    if (!data || !data.tripId || !data.driverId) {
      logger.warn('Socket driver_reject: Invalid payload parameters', data);
      return;
    }

    const { tripId, driverId } = data;
    logger.info(`Socket: Driver ${driverId} rejected trip ${tripId}`);

    try {
      // 1. Record reject response state in Redis
      await redisStateService.recordDriverResponse(tripId, driverId, 'rejected');

      // 2. Add driver to exclusions to prevent future matches
      await redisStateService.addExcludedDriver(tripId, driverId);

      // 3. Log rejection into MongoDB
      const rejectLog = matchingService.buildMatchLog(MATCH_EVENTS.DRIVER_TRIP_RESPONSE, driverId, {
        response: 'rejected',
        reason: 'Driver rejected request'
      });
      await tripService.appendMatchLog(tripId, [rejectLog]);

      // 4. Check if all shortlisted drivers have responded
      const shortlist = await redisStateService.getShortlist(tripId);
      const responses = await redisStateService.getDriverResponses(tripId);

      // If all have responded (rejected or timed out), skip waiting and trigger retry immediately
      const allResponded = shortlist.every(id => responses[id] === 'rejected' || responses[id] === 'timeout');

      if (allResponded) {
        logger.info(`Socket: All shortlisted drivers responded for trip ${tripId}. Bypassing timeout, triggering next attempt.`);
        const attempt = await redisStateService.getAttemptCount(tripId) || 1;
        const maxAttempts = 3;

        if (attempt < maxAttempts) {
          const allExcluded = await redisStateService.getExcludedDrivers(tripId);
          await addMatchingJob({
            tripId,
            attempt: attempt + 1,
            excludedDriverIds: Array.from(allExcluded)
          });
        } else {
          logger.warn(`Socket: Trip ${tripId} matching failed. Max attempts reached early.`);
          await tripService.markTripAsFailed(tripId, FAILURE_REASONS.NO_AVAILABLE_DRIVERS);

          const failLog = matchingService.buildMatchLog(MATCH_EVENTS.MATCH_FAILED, null, {
            attempt,
            reason: FAILURE_REASONS.NO_AVAILABLE_DRIVERS
          });
          await tripService.appendMatchLog(tripId, [failLog]);
          await addCleanupJob({ tripId, reason: 'failed' });
        }
      }
    } catch (err) {
      logger.error(`Socket: Failed to handle driver rejection: ${err.message}`, { error: err });
    }
  });

  /**
   * Atomic Acceptance State Machine Guard
   * Event: driver_accept
   * Payload: { tripId: String, driverId: String }
   */
  socket.on('driver_accept', async (data) => {
    if (!data || !data.tripId || !data.driverId) {
      logger.warn('Socket driver_accept: Invalid payload parameters', data);
      return;
    }

    const { tripId, driverId } = data;
    logger.info(`Socket: Driver ${driverId} attempting to accept trip ${tripId}`);

    try {
      // Step 1: Run atomic challenge lock statement via state service
      const lockAcquired = await redisStateService.acquireTripLock(tripId, driverId);
      if (!lockAcquired) {
        logger.info(`Socket: Driver ${driverId} failed lock challenge for trip ${tripId}`);
        return socket.emit('trip_error', { reason: "ORDER_TAKEN" });
      }

      // Step 2: Extract quick matching status variable state metrics
      const matchStatus = await redisStateService.getTripMatchingStatus(tripId);
      if (matchStatus === 'allocated') {
        logger.info(`Socket: Trip ${tripId} already allocated. Releasing lock.`);
        return socket.emit('trip_error', { reason: "TRIP_ALLOCATED_ALREADY" });
      }

      // Step 3: Shift matching status variable atomically inside caching store
      await redisStateService.setTripMatchingStatus(tripId, 'allocated');

      // Step 4: Call structural Trip update transactions
      const updatedTrip = await Trip.findOneAndUpdate(
        { _id: tripId, status: "MATCHING" },
        { 
          $set: { 
            status: "ACCEPTED", 
            driverId: driverId,
            assignedAt: Date.now() / 1000 
          },
          $push: { 
            rideMatchLog: {
              event: "driver_trip_response",
              driver_id: driverId,
              response: "accept",
              timestamp: Date.now()
            },
            tripTimeline: { state: "ACCEPTED", timestamp: Date.now() }
          }
        },
        { new: true }
      );

      if (!updatedTrip) {
        logger.warn(`Socket: Database update failed for trip ${tripId} (status might have changed or cancelled).`);
        await redisStateService.releaseTripLock(tripId);
        await redisStateService.setTripMatchingStatus(tripId, 'in_progress');
        return socket.emit('trip_error', { reason: "ORDER_TAKEN" });
      }

      // Step 5: Broadcast success confirmation markers across channels
      io.to(`driver:room:${driverId}`).emit('trip_assignment_confirmed', { tripId });

      // Step 6: Notify losing candidate groups inside the specific trip namespace boundary
      const shortlist = await redisStateService.getShortlist(tripId);
      shortlist.forEach(id => {
        if (id !== driverId) {
          io.to(`driver:room:${id}`).emit('trip_request_withdrawn', { tripId, reason: "TAKEN" });
        }
      });

      // Step 7: Push reference directly to cleanup worker queue structure boundaries
      await addCleanupJob({ tripId, reason: "allocated" });

      logger.info(`Socket: Trip ${tripId} successfully allocated to driver ${driverId}`);
    } catch (err) {
      logger.error(`Socket: Failed to process driver acceptance: ${err.message}`, { error: err });
      socket.emit('trip_error', { reason: "SERVER_ERROR", message: err.message });
    }
  });
};

module.exports = {
  registerHandlers
};
