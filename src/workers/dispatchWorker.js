// Dispatch Worker: dispatches ride request notifications to shortlisted drivers and manages response timeouts.
const { Worker } = require('bullmq');
const config = require('../config/env');
const { createClientConnection } = require('../config/redis');
const tripService = require('../services/tripService');
const matchingService = require('../services/matchingService');
const { getIO } = require('../socket/gateway');
const { addMatchingJob } = require('../queues/matchingQueue');
const { MATCH_EVENTS } = require('../utils/constants');
const logger = require('../utils/logger');

// Dedicated connection for the dispatch worker
const connection = createClientConnection();

const processJob = async (job) => {
  const { tripId, shortlistedDriverIds, fareAmount, attempt } = job.data;
  logger.info(`Dispatch Worker: Processing dispatch job for trip ${tripId}, attempt ${attempt}`);

  try {
    // 1. Initialize State: Load trip and check if status is still MATCHING
    const trip = await tripService.getTripById(tripId);
    if (!trip) {
      logger.error(`Dispatch Worker: Trip ${tripId} not found in database.`);
      return;
    }

    if (trip.status !== 'MATCHING') {
      logger.info(`Dispatch Worker: Trip ${tripId} status is ${trip.status} (expected MATCHING). Exiting dispatch.`);
      return;
    }

    // 2. Audit Target Trail: Record "socket_message_sent" logs in MongoDB
    const logEntries = shortlistedDriverIds.map(driverId => {
      return matchingService.buildMatchLog(MATCH_EVENTS.SOCKET_MESSAGE_SENT, driverId);
    });
    await tripService.appendMatchLog(tripId, logEntries);

    // 3. Emit Real-Time Alert to each driver
    const io = getIO();
    const timeoutMs = config.matching.driverResponseTimeoutMs || 15000;
    const socketPayload = {
      tripId,
      fare: fareAmount,
      currency: '₹',
      attempt,
      timeoutMs
    };

    for (const driverId of shortlistedDriverIds) {
      if (io) {
        logger.debug(`Dispatch Worker: Emitting trip_request to room driver:room:${driverId}`);
        io.to(`driver:room:${driverId}`).emit('trip_request', socketPayload);
      } else {
        logger.warn(`Dispatch Worker: Socket.IO not initialized. Skipping broadcast to driver ${driverId}`);
      }
    }

    // 4. Register Expiry Window Timer: Push a delayed fallback timeout check job to ad_matching queue
    logger.info(`Dispatch Worker: Scheduling timeout check job in ${timeoutMs}ms for trip ${tripId}`);
    await addMatchingJob(
      {
        tripId,
        attempt,
        isTimeoutCheck: true
      },
      {
        delay: timeoutMs,
        jobId: `${tripId}_timeout_${attempt}`
      }
    );

    logger.info(`Dispatch Worker: Completed dispatch sequence for trip ${tripId}`);
  } catch (err) {
    logger.error(`Dispatch Worker: Failed to execute dispatch job for trip ${tripId}: ${err.message}`, { error: err });
    throw err;
  }
};

const dispatchWorker = new Worker(
  config.queues.dispatch,
  processJob,
  {
    connection,
    concurrency: 10
  }
);

dispatchWorker.processJob = processJob;
dispatchWorker.on('error', (err) => {
  logger.error(`Dispatch Worker global error: ${err.message}`, { error: err });
});

module.exports = dispatchWorker;
