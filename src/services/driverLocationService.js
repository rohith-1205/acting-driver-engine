// Driver Location Service: manages driver location data in Redis GEO and driver status meta hashes.
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

const buildGeoKey = (regionCode) => `geo:acting_drivers:${regionCode.toUpperCase()}`;
const buildMetaKey = (driverId) => `driver:${driverId}:meta`;

/**
 * Adds or updates a driver's location in the GEO set and caches metadata.
 * @param {string} driverId 
 * @param {number} longitude 
 * @param {number} latitude 
 * @param {string} regionCode 
 */
const upsertDriverLocation = async (driverId, longitude, latitude, regionCode) => {
  const geoKey = buildGeoKey(regionCode);
  const metaKey = buildMetaKey(driverId);
  const redis = getRedisClient();
  const nowStr = String(Date.now());
  
  try {
    logger.debug(`Upserting location for driver ${driverId} in region ${regionCode} to [${longitude}, ${latitude}]`);
    await redis.multi()
      .geoadd(geoKey, longitude, latitude, driverId)
      .hset(metaKey, 'regionCode', regionCode, 'isOnline', '1', 'tripStatus', 'NOTRIP', 'lastSeen', nowStr)
      .expire(metaKey, 3600)
      .exec();
  } catch (err) {
    logger.error(`Failed to upsert driver location for ${driverId}: ${err.message}`);
    throw new Error(`Failed to upsert driver location: ${err.message}`);
  }
};

/**
 * Removes driver from the GEO set and deletes metadata.
 * @param {string} driverId 
 * @param {string} regionCode 
 */
const removeDriverLocation = async (driverId, regionCode) => {
  const geoKey = buildGeoKey(regionCode);
  const metaKey = buildMetaKey(driverId);
  const redis = getRedisClient();
  
  try {
    logger.debug(`Removing location and metadata for driver ${driverId} in region ${regionCode}`);
    await redis.multi()
      .zrem(geoKey, driverId)
      .del(metaKey)
      .exec();
  } catch (err) {
    logger.error(`Failed to remove driver location for ${driverId}: ${err.message}`);
    throw new Error(`Failed to remove driver location: ${err.message}`);
  }
};

/**
 * Find all drivers within radiusKm of the coordinates.
 * @param {number} longitude 
 * @param {number} latitude 
 * @param {number} radiusKm 
 * @param {string} regionCode 
 * @returns {Promise<Array<{ driverId: string, distanceKm: number }>>}
 */
const findNearbyDrivers = async (longitude, latitude, radiusKm, regionCode) => {
  const geoKey = buildGeoKey(regionCode);
  const redis = getRedisClient();
  
  try {
    logger.debug(`Searching for drivers within ${radiusKm}km of [${longitude}, ${latitude}] in region ${regionCode}`);
    const rawResults = await redis.georadius(geoKey, longitude, latitude, radiusKm, 'km', 'ASC', 'WITHDIST', 'COUNT', 50);
    
    if (!rawResults || !Array.isArray(rawResults)) {
      return [];
    }
    
    return rawResults.map(result => {
      return {
        driverId: result[0],
        distanceKm: parseFloat(result[1])
      };
    });
  } catch (err) {
    logger.error(`Failed to find nearby drivers in region ${regionCode}: ${err.message}`);
    throw new Error(`Failed to find nearby drivers: ${err.message}`);
  }
};

/**
 * Returns the driver meta hash as a plain JS object.
 * @param {string} driverId 
 * @returns {Promise<Object|null>}
 */
const getDriverMeta = async (driverId) => {
  const metaKey = buildMetaKey(driverId);
  const redis = getRedisClient();
  
  try {
    logger.debug(`Fetching metadata for driver ${driverId}`);
    const meta = await redis.hgetall(metaKey);
    if (!meta || Object.keys(meta).length === 0) {
      return null;
    }
    return meta;
  } catch (err) {
    logger.error(`Failed to get driver meta for ${driverId}: ${err.message}`);
    throw new Error(`Failed to get driver meta: ${err.message}`);
  }
};

/**
 * Fetch all meta hashes for multiple driver IDs in a single pipeline.
 * @param {string[]} driverIds 
 * @returns {Promise<Array<Object|null>>}
 */
const bulkGetDriverMeta = async (driverIds) => {
  if (!driverIds || driverIds.length === 0) {
    return [];
  }
  
  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  
  driverIds.forEach(id => {
    pipeline.hgetall(buildMetaKey(id));
  });
  
  try {
    logger.debug(`Bulk fetching metadata for ${driverIds.length} drivers`);
    const rawResults = await pipeline.exec();
    
    return rawResults.map(result => {
      const [err, val] = result;
      if (err) {
        throw err;
      }
      if (!val || Object.keys(val).length === 0) {
        return null;
      }
      return val;
    });
  } catch (err) {
    logger.error(`Failed bulk fetch of driver metadata: ${err.message}`);
    throw new Error(`Failed bulk fetch of driver metadata: ${err.message}`);
  }
};

module.exports = {
  upsertDriverLocation,
  removeDriverLocation,
  findNearbyDrivers,
  getDriverMeta,
  bulkGetDriverMeta
};
