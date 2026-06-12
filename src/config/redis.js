// Redis Config: creates the ioredis client instance and verifies the connection with a ping test.
const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

let redisClient = null;

/**
 * Initializes the Redis client and pings the server to verify connectivity.
 * @returns {Promise<Redis>}
 */
const initRedis = async () => {
  try {
    logger.info(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`);
    
    const options = {
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: null // Required by BullMQ
    };
    
    if (config.redis.password) {
      options.password = config.redis.password;
    }
    
    redisClient = new Redis(options);
    
    redisClient.on('error', (err) => {
      logger.error(`Redis Client error: ${err.message}`);
    });
    
    // Test the connection
    const pingResult = await redisClient.ping();
    logger.info(`Successfully connected to Redis. Ping response: ${pingResult}`);
    
    return redisClient;
  } catch (err) {
    logger.error(`Failed to connect to Redis: ${err.message}`);
    throw err;
  }
};

/**
 * Returns the active Redis client.
 * @returns {Redis}
 */
const getRedisClient = () => {
  if (!redisClient) {
    throw new Error('Redis client has not been initialized. Call initRedis first.');
  }
  return redisClient;
};

/**
 * Returns a new Redis client instance (useful for BullMQ workers).
 * @returns {Redis}
 */
const createClientConnection = () => {
  const options = {
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null
  };
  if (config.redis.password) {
    options.password = config.redis.password;
  }
  return new Redis(options);
};

const redisClientProxy = new Proxy({}, {
  get: (target, prop) => {
    if (prop === 'ping') {
      return async () => {
        if (!redisClient) {
          await initRedis();
        }
        return redisClient.ping();
      };
    }
    if (prop === 'quit') {
      return async () => {
        if (redisClient) {
          return redisClient.quit();
        }
      };
    }
    return getRedisClient()[prop];
  }
});

module.exports = {
  initRedis,
  getRedisClient,
  createClientConnection,
  redisClient: redisClientProxy
};
