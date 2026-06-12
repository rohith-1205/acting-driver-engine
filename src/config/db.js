// DB Config: establishes connection to MongoDB using Mongoose with built-in retry logic.
const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

/**
 * Connects to MongoDB with retry logic
 * @param {number} maxAttempts - Maximum number of connection attempts
 * @param {number} delayMs - Time to wait between attempts in milliseconds
 * @returns {Promise<mongoose.Connection>}
 */
const connectWithRetry = async (maxAttempts = 5, delayMs = 5000) => {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      attempt++;
      logger.info(`Connecting to MongoDB at ${config.mongo.uri} (attempt ${attempt}/${maxAttempts})...`);
      await mongoose.connect(config.mongo.uri);
      logger.info('Successfully connected to MongoDB.');
      return mongoose.connection;
    } catch (err) {
      logger.error(`MongoDB connection attempt ${attempt} failed: ${err.message}`);
      if (attempt >= maxAttempts) {
        throw new Error(`Failed to connect to MongoDB after ${maxAttempts} attempts.`);
      }
      logger.warn(`Waiting ${delayMs / 1000}s before retrying MongoDB connection...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

module.exports = {
  connectWithRetry,
  connectDB: connectWithRetry
};
