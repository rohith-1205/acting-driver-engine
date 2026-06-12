// Redis State Service: contains high-performance operations to manage acting driver trip and scheduling states in Redis.
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

// Redis Key Patterns
const KEY_PATTERNS = {
  TRIP_STATUS: 'trip:%s:status',
  TRIP_SHORTLIST: 'trip:%s:shortlist',
  TRIP_RESPONSES: 'trip:%s:responses',
  TRIP_LOCK: 'trip:%s:lock',
  TRIP_ATTEMPT: 'trip:%s:attempt',
  TRIP_EXCLUDED_DRIVERS: 'trip:%s:excluded_drivers',
  TRIP_MATCHING_STATUS: 'trip:%s:matching_status',
  SCHEDULER_PENDING: 'scheduler:pending_trips',
  DRIVER_ACTIVE_TRIP: 'driver:%s:active_trip'
};

// Helper function to build keys from patterns
const buildKey = (pattern, id) => {
  if (id) {
    return pattern.replace('%s', id);
  }
  return pattern;
};

/**
 * Helper to safely retrieve the Redis client at runtime
 * @returns {Redis}
 */
const getClient = () => {
  try {
    return getRedisClient();
  } catch (err) {
    logger.error(`RedisStateService error retrieving client: ${err.message}`);
    throw err;
  }
};

/**
 * Sets the general status of a trip
 * @param {string} tripId 
 * @param {string} status 
 */
const setTripStatus = async (tripId, status) => {
  const key = buildKey(KEY_PATTERNS.TRIP_STATUS, tripId);
  try {
    logger.debug(`RedisStateService: setTripStatus for ${tripId} to ${status}`);
    await getClient().set(key, status, 'EX', 3600);
  } catch (err) {
    logger.error(`RedisStateService: setTripStatus failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to set trip status in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Retrieves the general status of a trip
 * @param {string} tripId 
 * @returns {Promise<string|null>}
 */
const getTripStatus = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_STATUS, tripId);
  try {
    logger.debug(`RedisStateService: getTripStatus for ${tripId}`);
    return await getClient().get(key);
  } catch (err) {
    logger.error(`RedisStateService: getTripStatus failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get trip status from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Sets the matching progress status of a trip
 * @param {string} tripId 
 * @param {string} status - "in_progress" | "allocated" | "failed"
 */
const setTripMatchingStatus = async (tripId, status) => {
  const key = buildKey(KEY_PATTERNS.TRIP_MATCHING_STATUS, tripId);
  try {
    logger.debug(`RedisStateService: setTripMatchingStatus for ${tripId} to ${status}`);
    await getClient().set(key, status, 'EX', 3600);
  } catch (err) {
    logger.error(`RedisStateService: setTripMatchingStatus failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to set trip matching status in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Retrieves the matching progress status of a trip
 * @param {string} tripId 
 * @returns {Promise<string|null>}
 */
const getTripMatchingStatus = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_MATCHING_STATUS, tripId);
  try {
    logger.debug(`RedisStateService: getTripMatchingStatus for ${tripId}`);
    return await getClient().get(key);
  } catch (err) {
    logger.error(`RedisStateService: getTripMatchingStatus failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get trip matching status from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Sets the current driver shortlist for a trip
 * @param {string} tripId 
 * @param {string[]} driverIds 
 */
const setShortlist = async (tripId, driverIds) => {
  const key = buildKey(KEY_PATTERNS.TRIP_SHORTLIST, tripId);
  try {
    logger.debug(`RedisStateService: setShortlist for ${tripId} with ${driverIds.length} drivers`);
    await getClient().set(key, JSON.stringify(driverIds), 'EX', 300);
  } catch (err) {
    logger.error(`RedisStateService: setShortlist failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to set shortlist in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Gets the current driver shortlist for a trip
 * @param {string} tripId 
 * @returns {Promise<string[]>}
 */
const getShortlist = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_SHORTLIST, tripId);
  try {
    logger.debug(`RedisStateService: getShortlist for ${tripId}`);
    const data = await getClient().get(key);
    return data ? JSON.parse(data) : [];
  } catch (err) {
    logger.error(`RedisStateService: getShortlist failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get shortlist from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Records a driver's match request response (e.g. accepted, rejected, timeout)
 * @param {string} tripId 
 * @param {string} driverId 
 * @param {string} response 
 */
const recordDriverResponse = async (tripId, driverId, response) => {
  const key = buildKey(KEY_PATTERNS.TRIP_RESPONSES, tripId);
  try {
    logger.debug(`RedisStateService: recordDriverResponse for ${tripId}, driver ${driverId}: ${response}`);
    await getClient()
      .multi()
      .hset(key, driverId, response)
      .expire(key, 300)
      .exec();
  } catch (err) {
    logger.error(`RedisStateService: recordDriverResponse failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to record driver response in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Retrieves all driver responses for a trip
 * @param {string} tripId 
 * @returns {Promise<Object>}
 */
const getDriverResponses = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_RESPONSES, tripId);
  try {
    logger.debug(`RedisStateService: getDriverResponses for ${tripId}`);
    const responses = await getClient().hgetall(key);
    return responses || {};
  } catch (err) {
    logger.error(`RedisStateService: getDriverResponses failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get driver responses from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Distributed lock to prevent double allocation.
 * Returns true if the lock was acquired successfully, false otherwise.
 * @param {string} tripId 
 * @param {string} driverId 
 * @returns {Promise<boolean>}
 */
const acquireTripLock = async (tripId, driverId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_LOCK, tripId);
  try {
    logger.debug(`RedisStateService: acquireTripLock attempt for ${tripId} by driver ${driverId}`);
    const result = await getClient().set(key, driverId, 'PX', 60000, 'NX');
    const acquired = result === 'OK';
    logger.info(`RedisStateService: acquireTripLock status for ${tripId} by driver ${driverId}: ${acquired}`);
    return acquired;
  } catch (err) {
    logger.error(`RedisStateService: acquireTripLock failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to acquire trip lock in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Releases the distributed lock for a trip
 * @param {string} tripId 
 */
const releaseTripLock = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_LOCK, tripId);
  try {
    logger.debug(`RedisStateService: releaseTripLock for ${tripId}`);
    await getClient().del(key);
  } catch (err) {
    logger.error(`RedisStateService: releaseTripLock failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to release trip lock in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Gets the current holder of the trip lock (driver ID)
 * @param {string} tripId 
 * @returns {Promise<string|null>}
 */
const getLockHolder = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_LOCK, tripId);
  try {
    logger.debug(`RedisStateService: getLockHolder for ${tripId}`);
    return await getClient().get(key);
  } catch (err) {
    logger.error(`RedisStateService: getLockHolder failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get lock holder from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Sets the matching attempt round count for a trip
 * @param {string} tripId 
 * @param {number} count 
 */
const setAttemptCount = async (tripId, count) => {
  const key = buildKey(KEY_PATTERNS.TRIP_ATTEMPT, tripId);
  try {
    logger.debug(`RedisStateService: setAttemptCount for ${tripId} to ${count}`);
    await getClient().set(key, String(count), 'EX', 3600);
  } catch (err) {
    logger.error(`RedisStateService: setAttemptCount failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to set attempt count in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Retrieves the matching attempt round count for a trip
 * @param {string} tripId 
 * @returns {Promise<number>}
 */
const getAttemptCount = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_ATTEMPT, tripId);
  try {
    logger.debug(`RedisStateService: getAttemptCount for ${tripId}`);
    const countStr = await getClient().get(key);
    return countStr ? parseInt(countStr, 10) : 0;
  } catch (err) {
    logger.error(`RedisStateService: getAttemptCount failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get attempt count from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Adds a driver ID to the exclusion list for a trip
 * @param {string} tripId 
 * @param {string} driverId 
 */
const addExcludedDriver = async (tripId, driverId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_EXCLUDED_DRIVERS, tripId);
  try {
    logger.debug(`RedisStateService: addExcludedDriver for ${tripId}: driver ${driverId}`);
    await getClient()
      .multi()
      .sadd(key, driverId)
      .expire(key, 3600)
      .exec();
  } catch (err) {
    logger.error(`RedisStateService: addExcludedDriver failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to add excluded driver in Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Gets the set of all excluded driver IDs for a trip
 * @param {string} tripId 
 * @returns {Promise<Set<string>>}
 */
const getExcludedDrivers = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.TRIP_EXCLUDED_DRIVERS, tripId);
  try {
    logger.debug(`RedisStateService: getExcludedDrivers for ${tripId}`);
    const members = await getClient().smembers(key);
    return new Set(members || []);
  } catch (err) {
    logger.error(`RedisStateService: getExcludedDrivers failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to get excluded drivers from Redis for trip ${tripId}: ${err.message}`);
  }
};

/**
 * Adds a trip to the sorted set scheduler
 * @param {string} tripId 
 * @param {number} scheduledTime - epoch milliseconds
 */
const addTripToScheduler = async (tripId, scheduledTime) => {
  const key = buildKey(KEY_PATTERNS.SCHEDULER_PENDING);
  try {
    logger.debug(`RedisStateService: addTripToScheduler for ${tripId} at ${scheduledTime}`);
    await getClient().zadd(key, scheduledTime, tripId);
  } catch (err) {
    logger.error(`RedisStateService: addTripToScheduler failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to add trip to scheduler in Redis: ${err.message}`);
  }
};

/**
 * Retrieves trip IDs that are due for scheduling (score <= now)
 * @param {number} limit 
 * @returns {Promise<string[]>}
 */
const getNextDueTrips = async (limit) => {
  const key = buildKey(KEY_PATTERNS.SCHEDULER_PENDING);
  try {
    const now = Date.now();
    logger.debug(`RedisStateService: getNextDueTrips with limit ${limit} up to time ${now}`);
    return await getClient().zrangebyscore(key, '-inf', now, 'LIMIT', 0, limit);
  } catch (err) {
    logger.error(`RedisStateService: getNextDueTrips failed: ${err.message}`);
    throw new Error(`Failed to fetch due trips from scheduler in Redis: ${err.message}`);
  }
};

/**
 * Removes a trip from the sorted set scheduler
 * @param {string} tripId 
 */
const removeTripFromScheduler = async (tripId) => {
  const key = buildKey(KEY_PATTERNS.SCHEDULER_PENDING);
  try {
    logger.debug(`RedisStateService: removeTripFromScheduler for ${tripId}`);
    await getClient().zrem(key, tripId);
  } catch (err) {
    logger.error(`RedisStateService: removeTripFromScheduler failed for ${tripId}: ${err.message}`);
    throw new Error(`Failed to remove trip from scheduler in Redis: ${err.message}`);
  }
};

/**
 * Maps a driver to their current active trip ID
 * @param {string} driverId 
 * @param {string} tripId 
 */
const setDriverActiveTrip = async (driverId, tripId) => {
  const key = buildKey(KEY_PATTERNS.DRIVER_ACTIVE_TRIP, driverId);
  try {
    logger.debug(`RedisStateService: setDriverActiveTrip for driver ${driverId} to trip ${tripId}`);
    await getClient().set(key, tripId, 'EX', 86400);
  } catch (err) {
    logger.error(`RedisStateService: setDriverActiveTrip failed for driver ${driverId}: ${err.message}`);
    throw new Error(`Failed to set driver active trip in Redis: ${err.message}`);
  }
};

/**
 * Clears the active trip mapping for a driver
 * @param {string} driverId 
 */
const clearDriverActiveTrip = async (driverId) => {
  const key = buildKey(KEY_PATTERNS.DRIVER_ACTIVE_TRIP, driverId);
  try {
    logger.debug(`RedisStateService: clearDriverActiveTrip for driver ${driverId}`);
    await getClient().del(key);
  } catch (err) {
    logger.error(`RedisStateService: clearDriverActiveTrip failed for driver ${driverId}: ${err.message}`);
    throw new Error(`Failed to clear driver active trip in Redis: ${err.message}`);
  }
};

/**
 * Retrieves the current active trip ID for a driver
 * @param {string} driverId 
 * @returns {Promise<string|null>}
 */
const getDriverActiveTrip = async (driverId) => {
  const key = buildKey(KEY_PATTERNS.DRIVER_ACTIVE_TRIP, driverId);
  try {
    logger.debug(`RedisStateService: getDriverActiveTrip for driver ${driverId}`);
    return await getClient().get(key);
  } catch (err) {
    logger.error(`RedisStateService: getDriverActiveTrip failed for driver ${driverId}: ${err.message}`);
    throw new Error(`Failed to get driver active trip from Redis: ${err.message}`);
  }
};

/**
 * Performs complete cleanup of all transient Redis keys associated with a trip
 * @param {string} tripId 
 */
const cleanupAllTripKeys = async (tripId) => {
  try {
    logger.info(`RedisStateService: cleanupAllTripKeys for trip ${tripId}`);
    const redis = getClient();
    const pipeline = redis.pipeline();
    
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_STATUS, tripId));
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_SHORTLIST, tripId));
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_RESPONSES, tripId));
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_LOCK, tripId));
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_ATTEMPT, tripId));
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_EXCLUDED_DRIVERS, tripId));
    pipeline.del(buildKey(KEY_PATTERNS.TRIP_MATCHING_STATUS, tripId));
    
    await pipeline.exec();
  } catch (err) {
    logger.error(`RedisStateService: cleanupAllTripKeys failed for trip ${tripId}: ${err.message}`);
    throw new Error(`Failed to clean up trip keys in Redis for trip ${tripId}: ${err.message}`);
  }
};

module.exports = {
  setTripStatus,
  getTripStatus,
  setTripMatchingStatus,
  getTripMatchingStatus,
  setShortlist,
  getShortlist,
  recordDriverResponse,
  getDriverResponses,
  acquireTripLock,
  releaseTripLock,
  getLockHolder,
  setAttemptCount,
  getAttemptCount,
  addExcludedDriver,
  getExcludedDrivers,
  addTripToScheduler,
  getNextDueTrips,
  removeTripFromScheduler,
  setDriverActiveTrip,
  clearDriverActiveTrip,
  getDriverActiveTrip,
  cleanupAllTripKeys
};
