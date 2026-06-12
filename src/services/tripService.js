// Trip Service: performs database operations on Mongoose trip models, updating trip state and assigning driver IDs.
const Trip = require('../models/Trip');
const logger = require('../utils/logger');

/**
 * Updates trip status to MATCHING
 * @param {string} tripId 
 * @returns {Promise<Object>}
 */
const markTripAsMatching = async (tripId) => {
  try {
    logger.info(`TripService: markTripAsMatching for trip ${tripId}`);
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: 'MATCHING' },
      { new: true }
    );
    if (!trip) {
      throw new Error(`Trip ${tripId} not found`);
    }
    return trip;
  } catch (err) {
    logger.error(`TripService: markTripAsMatching failed for trip ${tripId}: ${err.message}`);
    throw err;
  }
};

/**
 * Updates trip status to failed and sets failureReason
 * @param {string} tripId 
 * @param {string} failureReason 
 * @returns {Promise<Object>}
 */
const markTripAsFailed = async (tripId, failureReason) => {
  try {
    logger.info(`TripService: markTripAsFailed for trip ${tripId} with reason ${failureReason}`);
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: 'failed', failureReason },
      { new: true }
    );
    if (!trip) {
      throw new Error(`Trip ${tripId} not found`);
    }
    return trip;
  } catch (err) {
    logger.error(`TripService: markTripAsFailed failed for trip ${tripId}: ${err.message}`);
    throw err;
  }
};

/**
 * Appends log entries to the trip's rideMatchLog array atomically
 * @param {string} tripId 
 * @param {Array} logEntries 
 * @returns {Promise<Object>}
 */
const appendMatchLog = async (tripId, logEntries) => {
  try {
    logger.info(`TripService: appendMatchLog for trip ${tripId} with ${logEntries.length} entries`);
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { $push: { rideMatchLog: { $each: logEntries } } },
      { new: true }
    );
    if (!trip) {
      throw new Error(`Trip ${tripId} not found`);
    }
    return trip;
  } catch (err) {
    logger.error(`TripService: appendMatchLog failed for trip ${tripId}: ${err.message}`);
    throw err;
  }
};

/**
 * Fetches trip by _id. Returns null if not found.
 * @param {string} tripId 
 * @returns {Promise<Object|null>}
 */
const getTripById = async (tripId) => {
  try {
    logger.debug(`TripService: getTripById for trip ${tripId}`);
    return await Trip.findById(tripId);
  } catch (err) {
    logger.error(`TripService: getTripById failed for trip ${tripId}: ${err.message}`);
    throw err;
  }
};

/**
 * Updates matchAttempt field to the given number
 * @param {string} tripId 
 * @param {number} attempt 
 * @returns {Promise<Object>}
 */
const updateTripAttempt = async (tripId, attempt) => {
  try {
    logger.info(`TripService: updateTripAttempt for trip ${tripId} to ${attempt}`);
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { matchAttempt: attempt },
      { new: true }
    );
    if (!trip) {
      throw new Error(`Trip ${tripId} not found`);
    }
    return trip;
  } catch (err) {
    logger.error(`TripService: updateTripAttempt failed for trip ${tripId}: ${err.message}`);
    throw err;
  }
};

module.exports = {
  markTripAsMatching,
  markTripAsFailed,
  appendMatchLog,
  getTripById,
  updateTripAttempt
};
