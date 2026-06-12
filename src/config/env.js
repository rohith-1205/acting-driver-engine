// Env Config: loads, validates, and exports validated environment configurations.
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

const requiredEnvVars = [
  'MONGO_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'SCHEDULER_QUEUE_NAME',
  'MATCHING_QUEUE_NAME',
  'DISPATCH_QUEUE_NAME',
  'CLEANUP_QUEUE_NAME',
  'SOCKET_PORT',
  'PORT',
  'REGION_CODE',
  'MAX_MATCH_ATTEMPTS',
  'DRIVER_RESPONSE_TIMEOUT_MS',
  'SHORTLIST_SIZE',
  'MAX_DRIVER_SEARCH_RADIUS_KM',
  'MAX_CANCELLATION_RETRIES',
  'PLATFORM_MINIMUM_BUFFER_MS',
  'DEFAULT_BUFFER_MS',
  'MAX_BUFFER_MS',
  'AVERAGE_SPEED_KMPH',
  'SCORE_WEIGHT_DISTANCE',
  'SCORE_WEIGHT_RATING',
  'SCORE_WEIGHT_VEHICLE_MATCH',
  'SCORE_WEIGHT_EXPERIENCE',
  'SCORE_WEIGHT_NIGHT_DRIVING',
  'SCORE_WEIGHT_LONG_DISTANCE',
  'SCORE_WEIGHT_ACCEPTANCE_RATE'
];

for (const envVar of requiredEnvVars) {
  if (process.env[envVar] === undefined || process.env[envVar] === '') {
    throw new Error(`Required environment variable "${envVar}" is missing.`);
  }
}

const config = {
  mongo: {
    uri: process.env.MONGO_URI
  },
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT, 10),
    password: process.env.REDIS_PASSWORD || undefined
  },
  queues: {
    scheduler: process.env.SCHEDULER_QUEUE_NAME,
    matching: process.env.MATCHING_QUEUE_NAME,
    dispatch: process.env.DISPATCH_QUEUE_NAME,
    cleanup: process.env.CLEANUP_QUEUE_NAME
  },
  socket: {
    port: parseInt(process.env.SOCKET_PORT, 10)
  },
  app: {
    port: parseInt(process.env.PORT, 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    regionCode: process.env.REGION_CODE.toUpperCase()
  },
  matching: {
    maxMatchAttempts: parseInt(process.env.MAX_MATCH_ATTEMPTS, 10),
    driverResponseTimeoutMs: parseInt(process.env.DRIVER_RESPONSE_TIMEOUT_MS, 10),
    shortlistSize: parseInt(process.env.SHORTLIST_SIZE, 10),
    maxDriverSearchRadiusKm: parseFloat(process.env.MAX_DRIVER_SEARCH_RADIUS_KM),
    maxCancellationRetries: parseInt(process.env.MAX_CANCELLATION_RETRIES, 10),
    platformMinimumBufferMs: parseInt(process.env.PLATFORM_MINIMUM_BUFFER_MS, 10),
    defaultBufferMs: parseInt(process.env.DEFAULT_BUFFER_MS, 10),
    maxBufferMs: parseInt(process.env.MAX_BUFFER_MS, 10),
    averageSpeedKmph: parseFloat(process.env.AVERAGE_SPEED_KMPH),
    scoreWeightDistance: parseInt(process.env.SCORE_WEIGHT_DISTANCE, 10),
    scoreWeightRating: parseInt(process.env.SCORE_WEIGHT_RATING, 10),
    scoreWeightVehicleMatch: parseInt(process.env.SCORE_WEIGHT_VEHICLE_MATCH, 10),
    scoreWeightExperience: parseInt(process.env.SCORE_WEIGHT_EXPERIENCE, 10),
    scoreWeightNightDriving: parseInt(process.env.SCORE_WEIGHT_NIGHT_DRIVING, 10),
    scoreWeightLongDistance: parseInt(process.env.SCORE_WEIGHT_LONG_DISTANCE, 10),
    scoreWeightAcceptanceRate: parseInt(process.env.SCORE_WEIGHT_ACCEPTANCE_RATE, 10)
  }
};

module.exports = config;
